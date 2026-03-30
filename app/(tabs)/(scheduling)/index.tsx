import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  Pressable,
  Modal,
  Animated,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CalendarClock, Clock3, Play, Save, Sparkles, WandSparkles } from "lucide-react-native";
import { COLORS, glassCard } from "@/constants/AppColors";
import { GradientButton } from "@/components/GradientButton";
import { apiGet, apiPost, apiPut } from "@/utils/api";

type Channel = {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "error";
};

type VideoFile = {
  id: string;
  name: string;
  file_path: string;
  size_bytes: number;
  extension: string;
};

type ContentSettings = {
  titles: string[];
  description: string;
  tags: string[];
  videos_per_day: number;
  start_time: string;
};

type SlotItem = {
  slot_number: number;
  enabled?: boolean;
  time: string;
  date: string;
  video_id: string;
  video_name: string;
  title: string;
  upload_date: string;
  upload_time: string;
  manual_upload_time: boolean;
  auto_upload_enabled?: boolean;
  upload_mode?: "auto" | "manual";
  status: "scheduled" | "pending";
};

type AutoScheduleResponse = {
  success: boolean;
  plan?: {
    slots: Array<{
      slot_number: number;
      time: string;
      date: string;
      video_id: string;
      video_name: string;
      title: string;
      upload_date?: string;
      upload_time?: string;
      manual_upload_time?: boolean;
      upload_mode?: "auto" | "manual";
      status: "scheduled" | "pending";
    }>;
  };
  error?: string;
};

function tomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseStartMinutes(time: string) {
  const [h, m] = String(time || "04:00").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 4 * 60;
  return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
}

function toTimeString(totalMinutes: number) {
  const mins = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function randomizeTitles(titles: string[], count: number) {
  if (!titles.length) {
    return Array.from({ length: count }, (_, i) => `Auto Upload ${i + 1}`);
  }
  const pool = [...titles];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}

function seededUnit(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function parseDateTime(date: string, time: string) {
  const [y, m, d] = String(date || "").split("-").map(Number);
  const [hh, mm] = String(time || "00:00").split(":").map(Number);
  const value = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  if (Number.isNaN(value.getTime())) return null;
  return value;
}

function formatDateTimeParts(date: Date) {
  return {
    upload_date: date.toISOString().slice(0, 10),
    upload_time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

function deriveUploadDateTime(date: string, time: string, slotNumber: number) {
  const [y, m, d] = String(date || "").split("-").map(Number);
  const [hh, mm] = String(time || "04:00").split(":").map(Number);
  const publish = new Date(y, (m || 1) - 1, d || 1, hh || 4, mm || 0, 0, 0);
  if (Number.isNaN(publish.getTime())) {
    return { upload_date: date, upload_time: "16:00" };
  }

  const midnight = new Date(publish);
  midnight.setHours(0, 0, 0, 0);
  const slot = Math.max(1, Math.min(5, slotNumber));
  const windows: Record<number, { startOffset: number; startHour: number; endOffset: number; endHour: number }> = {
    1: { startOffset: -1, startHour: 16, endOffset: -1, endHour: 20 },
    2: { startOffset: -1, startHour: 21, endOffset: 0, endHour: 0 },
    3: { startOffset: 0, startHour: 3, endOffset: 0, endHour: 6 },
    4: { startOffset: 0, startHour: 7, endOffset: 0, endHour: 9 },
    5: { startOffset: 0, startHour: 9, endOffset: 0, endHour: 11 },
  };
  const win = windows[slot];
  const start = new Date(midnight);
  start.setDate(start.getDate() + win.startOffset);
  start.setHours(win.startHour, 0, 0, 0);

  const end = new Date(midnight);
  end.setDate(end.getDate() + win.endOffset);
  end.setHours(win.endHour, 0, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);

  const ratio = seededUnit(`${date}:${time}:${slotNumber}:upload`);
  const candidate = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) * ratio));
  const secondVar = Math.floor(seededUnit(`${date}:${time}:${slotNumber}:sec`) * 59);
  candidate.setSeconds(secondVar, 0);

  const minGapMs = 2 * 60 * 60 * 1000;
  if ((publish.getTime() - candidate.getTime()) < minGapMs) {
    candidate.setTime(publish.getTime() - minGapMs - Math.floor(seededUnit(`${date}:${time}:${slotNumber}:gap`) * 30 * 60 * 1000));
  }

  return formatDateTimeParts(candidate);
}

function validateSlotTiming(slot: SlotItem) {
  if (slot.enabled === false) return "";
  const publish = parseDateTime(slot.date, slot.time);
  const upload = parseDateTime(slot.upload_date, slot.upload_time);
  if (!publish || !upload) return "Invalid date/time format.";
  if (upload >= publish) return "Upload date/time must be before publish date/time.";
  const diffHours = (publish.getTime() - upload.getTime()) / (1000 * 60 * 60);
  if (diffHours < 2) return "Minimum required gap is 2 hours.";
  return "";
}

function applySlotRules(base: SlotItem, patch: Partial<SlotItem>) {
  const next: SlotItem = { ...base, ...patch };
  const hasAutoFlag = Object.prototype.hasOwnProperty.call(patch, "auto_upload_enabled");
  if (hasAutoFlag) {
    next.auto_upload_enabled = Boolean(patch.auto_upload_enabled);
    next.manual_upload_time = !next.auto_upload_enabled;
  } else if (Object.prototype.hasOwnProperty.call(patch, "manual_upload_time")) {
    next.manual_upload_time = Boolean(patch.manual_upload_time);
    next.auto_upload_enabled = !next.manual_upload_time;
  } else if (next.auto_upload_enabled === undefined) {
    next.auto_upload_enabled = !next.manual_upload_time;
  }

  if (next.auto_upload_enabled) {
    const autoValue = deriveUploadDateTime(next.date, next.time, next.slot_number);
    next.upload_date = autoValue.upload_date;
    next.upload_time = autoValue.upload_time;
    next.manual_upload_time = false;
    next.upload_mode = "auto";
  } else {
    next.manual_upload_time = true;
    next.upload_mode = "manual";
  }

  return next;
}

function ensureSlotUploadFields(slot: Partial<SlotItem> & { slot_number: number; date: string; time: string }): SlotItem {
  const fallback = deriveUploadDateTime(slot.date, slot.time, slot.slot_number);
  const autoEnabled = slot.auto_upload_enabled !== undefined
    ? Boolean(slot.auto_upload_enabled)
    : !Boolean(slot.manual_upload_time);
  const manual = !autoEnabled;
  return {
    slot_number: slot.slot_number,
    time: String(slot.time || ""),
    date: String(slot.date || ""),
    video_id: String(slot.video_id || ""),
    video_name: String(slot.video_name || "No video selected"),
    title: String(slot.title || ""),
    status: (slot.status as "scheduled" | "pending") || "scheduled",
    upload_date: String(slot.upload_date || fallback.upload_date),
    upload_time: String(slot.upload_time || fallback.upload_time),
    manual_upload_time: manual,
    auto_upload_enabled: autoEnabled,
    upload_mode: manual ? "manual" : "auto",
    enabled: slot.enabled !== false,
  };
}

function buildAutoSlots(input: {
  videosPerDay: number;
  startTime: string;
  date: string;
  videos: VideoFile[];
  titles: string[];
  offset?: number;
}): SlotItem[] {
  const count = Math.max(1, Math.min(24, Number(input.videosPerDay || 1)));
  const startMinutes = parseStartMinutes(input.startTime);
  const gap = 1440 / count;
  const titles = randomizeTitles(input.titles, count);
  const videos = input.videos || [];
  const offset = input.offset || 0;

  const slots: SlotItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const video = videos.length ? videos[(offset + i) % videos.length] : null;
    slots.push({
      slot_number: i + 1,
      time: toTimeString(startMinutes + i * gap),
      date: input.date,
      video_id: video?.id || "",
      video_name: video?.name || "No video selected",
      title: titles[i],
      ...deriveUploadDateTime(input.date, toTimeString(startMinutes + i * gap), i + 1),
      manual_upload_time: false,
      auto_upload_enabled: true,
      upload_mode: "auto",
      status: "scheduled",
    });
  }
  return slots;
}

export default function SchedulingScreen() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{ channelId: string; slotNumber: number } | null>(null);
  const [videoCursor, setVideoCursor] = useState(0);

  const [titleInput, setTitleInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [tagList, setTagList] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [videosPerDayInput, setVideosPerDayInput] = useState("5");
  const [startTimeInput, setStartTimeInput] = useState("04:00");
  const [targetDateInput, setTargetDateInput] = useState(tomorrowDate());
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [autoScheduleEnabled, setAutoScheduleEnabled] = useState(true);
  const [minGapHours, setMinGapHours] = useState("2");
  const [maxGapHours, setMaxGapHours] = useState("6");
  const [variationMinutes, setVariationMinutes] = useState("30");
  const [enableDailyShift, setEnableDailyShift] = useState(true);
  const [channelSlotPlans, setChannelSlotPlans] = useState<Record<string, SlotItem[]>>({});

  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [toast, setToast] = useState("");

  const connectedChannels = useMemo(
    () => channels.filter((c) => c.status === "connected"),
    [channels],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [toastOpacity]);

  const fetchData = useCallback(async () => {
    try {
      const [ch, vid, settings] = await Promise.all([
        apiGet<{ channels: Channel[] }>("/api/channels"),
        apiGet<{ videos: VideoFile[] }>("/api/videos"),
        apiGet<{ settings: ContentSettings }>("/api/content-settings"),
      ]);
      const channelList = Array.isArray(ch?.channels) ? ch.channels : [];
      const videoList = Array.isArray(vid?.videos) ? vid.videos : [];
      const s = settings?.settings;

      setChannels(channelList);
      const activeIds = channelList.filter((item) => item.status === "connected").map((item) => item.id);
      setSelectedChannelIds(activeIds);
      setVideos(videoList);
      setVideosPerDayInput(String(s?.videos_per_day || 5));
      setStartTimeInput(s?.start_time || "04:00");
      setTitleInput((s?.titles || []).join("\n"));
      setDescriptionInput(s?.description || "");
      setTagList(Array.isArray(s?.tags) ? s.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : []);

      const previewSlots = buildAutoSlots({
        videosPerDay: Number(s?.videos_per_day || 5),
        startTime: s?.start_time || "04:00",
        date: targetDateInput,
        videos: videoList,
        titles: s?.titles || [],
        offset: 0,
      });
      console.log("[Scheduling] Initial slots generated:", previewSlots.length);
      const normalized = previewSlots.map((slot) => ensureSlotUploadFields(slot));
      setSlots(normalized);
      setChannelSlotPlans(
        Object.fromEntries(activeIds.map((channelId) => [channelId, normalized.slice(0, 5).map((slot) => ({ ...slot }))])),
      );
    } catch (error) {
      console.error("[Scheduling] fetchData failed", error);
      showToast("Failed to load scheduling data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast, targetDateInput]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const titles = titleInput.split("\n").map((t) => t.trim()).filter(Boolean);
    const preview = buildAutoSlots({
      videosPerDay: Number(videosPerDayInput || 5),
      startTime: startTimeInput,
      date: targetDateInput,
      videos,
      titles,
      offset: videoCursor,
    });
    console.log("[Scheduling] Re-render slots from state:", preview.length);
    setSlots(preview.map((slot) => ensureSlotUploadFields(slot)));
  }, [videosPerDayInput, startTimeInput, targetDateInput, videoCursor, videos, titleInput]);

  useEffect(() => {
    if (!selectedChannelIds.length || !slots.length) return;
    setChannelSlotPlans((prev) => {
      const next = { ...prev };
      selectedChannelIds.forEach((channelId) => {
        if (!Array.isArray(next[channelId]) || !next[channelId].length) {
          next[channelId] = slots.slice(0, 5).map((slot) => ({ ...slot }));
        }
      });
      return next;
    });
  }, [selectedChannelIds, slots]);

  const saveContentSettings = async () => {
    const titles = titleInput.split("\n").map((t) => t.trim()).filter(Boolean);
    const tags = tagList.map((t) => t.trim()).filter(Boolean);
    const videosPerDay = Math.max(1, Math.min(24, Number(videosPerDayInput || 5)));
    const startTime = /^\d{2}:\d{2}$/.test(startTimeInput) ? startTimeInput : "04:00";

    await apiPut("/api/content-settings", {
      titles,
      description: descriptionInput,
      tags,
      videos_per_day: videosPerDay,
      start_time: startTime,
    });
  };

  const onAutoSelectVideos = () => {
    if (!videos.length) {
      showToast("No videos found");
      return;
    }
    const nextCursor = (videoCursor + slots.length) % videos.length;
    setVideoCursor(nextCursor);
    showToast("Videos auto-selected");
  };

  const onAutoSchedule = async () => {
    if (!autoScheduleEnabled) {
      showToast("Auto schedule is OFF. Enable it to generate automatically.");
      return;
    }
    if (!connectedChannels.length) {
      showToast("No connected channels");
      return;
    }
    if (!videos.length) {
      showToast("No videos in library");
      return;
    }
    setBusy(true);
    try {
      await saveContentSettings();
      const result = await apiPost<AutoScheduleResponse>("/api/auto-schedule", {
        target_date: targetDateInput,
        videos_per_day: Number(videosPerDayInput || 5),
        start_time: startTimeInput,
      });
      if (!result?.success) {
        throw new Error(result?.error || "Auto schedule failed");
      }
      const nextSlots = result.plan?.slots || [];
      console.log("[Scheduling] Auto schedule response slots:", nextSlots.length, nextSlots);
      const normalized = nextSlots.map((slot) => ensureSlotUploadFields(slot));
      setSlots(normalized);
      const targets = selectedChannelIds.length ? selectedChannelIds : connectedChannels.map((item) => item.id);
      setChannelSlotPlans((prev) => ({
        ...prev,
        ...Object.fromEntries(targets.map((channelId) => [channelId, normalized.slice(0, 5).map((slot) => ({ ...slot }))])),
      }));
      showToast(`Scheduled ${nextSlots.length} slots`);
    } catch (error: any) {
      console.error("[Scheduling] Auto schedule error", error);
      showToast(error?.message || "Auto schedule failed");
    } finally {
      setBusy(false);
    }
  };

  const onSavePlan = async () => {
    if (!slots.length) {
      showToast("No slots to save");
      return;
    }
    setBusy(true);
    try {
      const plansToValidate = Object.entries(channelSlotPlans).flatMap(([channelId, plan]) =>
        (plan || []).filter((slot) => slot.enabled !== false).map((slot) => ({ channelId, slot })),
      );
      for (const item of plansToValidate) {
        const error = validateSlotTiming(item.slot);
        if (error) {
          showToast(`Channel ${item.channelId} Slot ${item.slot.slot_number}: ${error}`);
          setBusy(false);
          return;
        }
      }

      await saveContentSettings();
      await apiPost("/api/auto-schedule/save", {
        auto_schedule_enabled: autoScheduleEnabled,
        selected_channel_ids: selectedChannelIds,
        scheduler_config: {
          min_gap_hours: Math.max(1, Number(minGapHours || 2)),
          max_gap_hours: Math.max(2, Number(maxGapHours || 6)),
          time_variation_minutes: Math.max(0, Number(variationMinutes || 30)),
          enable_daily_shift: enableDailyShift,
        },
        channel_slot_plans: Object.fromEntries(
          Object.entries(channelSlotPlans).map(([channelId, plan]) => [
            channelId,
            (plan || [])
              .filter((slot) => slot.enabled !== false)
              .map((slot) => ({
                slot_number: slot.slot_number,
                publish_date: slot.date,
                publish_time: slot.time,
                time: slot.time,
                date: slot.date,
                video_id: slot.video_id,
                title: slot.title,
                upload_date: slot.upload_date,
                upload_time: slot.upload_time,
                manual_upload_time: slot.manual_upload_time,
                auto_upload_enabled: slot.auto_upload_enabled !== false,
              })),
          ]),
        ),
        slots: slots.map((slot) => ({
          slot_number: slot.slot_number,
          publish_date: slot.date,
          publish_time: slot.time,
          time: slot.time,
          date: slot.date,
          video_id: slot.video_id,
          title: slot.title,
          upload_date: slot.upload_date,
          upload_time: slot.upload_time,
          manual_upload_time: slot.manual_upload_time,
          auto_upload_enabled: slot.auto_upload_enabled !== false,
        })),
      });
      showToast("Plan saved");
    } catch (error) {
      console.error("[Scheduling] Save plan error", error);
      showToast("Failed to save plan");
    } finally {
      setBusy(false);
    }
  };

  const onStartAutomation = async () => {
    setBusy(true);
    try {
      await apiPost("/api/upload/start");
      showToast("Automation started");
    } catch (error: any) {
      console.error("[Scheduling] Start automation error", error);
      showToast(error?.message || "Start automation failed");
    } finally {
      setBusy(false);
    }
  };

  const updateChannelSlot = (channelId: string, slotNumber: number, patch: Partial<SlotItem>) => {
    setChannelSlotPlans((prev) => ({
      ...prev,
      [channelId]: (prev[channelId] || slots).map((slot) =>
        slot.slot_number === slotNumber ? applySlotRules(slot, patch) : slot,
      ),
    }));
  };

  const addTag = () => {
    const next = tagDraft.trim().replace(/^,+|,+$/g, "");
    if (!next) return;
    setTagList((prev) => (prev.includes(next) ? prev : [...prev, next]));
    setTagDraft("");
  };

  const removeTag = (tag: string) => {
    setTagList((prev) => prev.filter((item) => item !== tag));
  };

  const activePickerSlot = pickerTarget
    ? (channelSlotPlans[pickerTarget.channelId] || []).find((s) => s.slot_number === pickerTarget.slotNumber) || null
    : null;

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchData();
              }}
              tintColor={COLORS.primary}
            />
          }
          showsVerticalScrollIndicator
        >
          <View style={[glassCard, styles.card]}>
            <Text style={styles.mainTitle}>Automation Panel</Text>
            <Text style={styles.subTitle}>Visible slot-based scheduling</Text>
            <Text style={styles.metaText}>Connected Channels: {connectedChannels.length}</Text>
            <Text style={styles.metaText}>Videos Available: {videos.length}</Text>
          </View>

          <View style={[glassCard, styles.card]}>
            <Text style={styles.schedulerTitle}>Automation Scheduler</Text>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>AUTO SCHEDULE</Text>
              <Pressable style={styles.modeBtn} onPress={() => setAutoScheduleEnabled((prev) => !prev)}>
                <Text style={styles.modeText}>{autoScheduleEnabled ? "ON" : "OFF"}</Text>
              </Pressable>
            </View>
            <Text style={styles.sectionTitle}>Videos per Day</Text>
            <TextInput
              value={videosPerDayInput}
              onChangeText={setVideosPerDayInput}
              keyboardType="number-pad"
              style={styles.input}
              placeholder="5"
              placeholderTextColor={COLORS.textTertiary}
            />

            <Text style={styles.sectionLabel}>Default Start Time</Text>
            <TextInput
              value={startTimeInput}
              onChangeText={setStartTimeInput}
              style={styles.input}
              placeholder="04:00"
              placeholderTextColor={COLORS.textTertiary}
            />

            <Text style={styles.sectionLabel}>Schedule Date</Text>
            <TextInput
              value={targetDateInput}
              onChangeText={setTargetDateInput}
              style={styles.input}
              placeholder={tomorrowDate()}
              placeholderTextColor={COLORS.textTertiary}
            />

            <Text style={styles.sectionLabel}>Active Channels Today</Text>
            <View style={styles.tagsWrap}>
              {connectedChannels.map((channel) => {
                const active = selectedChannelIds.includes(channel.id);
                return (
                  <Pressable
                    key={channel.id}
                    style={[styles.tagChip, active ? styles.tagChipActive : null]}
                    onPress={() =>
                      setSelectedChannelIds((prev) =>
                        prev.includes(channel.id)
                          ? prev.filter((id) => id !== channel.id)
                          : [...prev, channel.id],
                      )
                    }
                  >
                    <Text style={[styles.tagChipText, active ? styles.tagChipTextActive : null]}>{channel.name || channel.id}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={[glassCard, styles.card]}>
            <Text style={styles.sectionTitle}>Randomization Control</Text>
            <Text style={styles.sectionLabel}>Min Gap (hours)</Text>
            <TextInput value={minGapHours} onChangeText={setMinGapHours} keyboardType="number-pad" style={styles.input} />
            <Text style={styles.sectionLabel}>Max Gap (hours)</Text>
            <TextInput value={maxGapHours} onChangeText={setMaxGapHours} keyboardType="number-pad" style={styles.input} />
            <Text style={styles.sectionLabel}>Time Variation (minutes)</Text>
            <TextInput value={variationMinutes} onChangeText={setVariationMinutes} keyboardType="number-pad" style={styles.input} />
            <View style={styles.rowBetween}>
              <Text style={styles.sectionLabel}>Enable Daily Shift</Text>
              <Pressable style={styles.modeBtn} onPress={() => setEnableDailyShift((prev) => !prev)}>
                <Text style={styles.modeText}>{enableDailyShift ? "ON" : "OFF"}</Text>
              </Pressable>
            </View>
          </View>

          <View style={[glassCard, styles.card]}>
            <Text style={styles.sectionTitle}>Content Settings</Text>
            <Text style={styles.sectionLabel}>Titles (one per line)</Text>
            <TextInput
              multiline
              value={titleInput}
              onChangeText={setTitleInput}
              style={[styles.input, styles.multiLine]}
              placeholder={"Title 1\nTitle 2\nTitle 3"}
              placeholderTextColor={COLORS.textTertiary}
            />
            <Text style={styles.sectionLabel}>Description</Text>
            <TextInput
              multiline
              value={descriptionInput}
              onChangeText={setDescriptionInput}
              style={[styles.input, styles.mediumLine]}
              placeholder="Global description"
              placeholderTextColor={COLORS.textTertiary}
            />
            <Text style={styles.sectionLabel}>Tags</Text>
            <View style={styles.tagsWrap}>
              {tagList.map((tag) => (
                <Pressable key={tag} style={styles.tagChip} onPress={() => removeTag(tag)}>
                  <Text style={styles.tagChipText}>{tag}  x</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={tagDraft}
              onChangeText={setTagDraft}
              onSubmitEditing={addTag}
              onBlur={addTag}
              style={styles.input}
              placeholder="Type tag and press enter"
              placeholderTextColor={COLORS.textTertiary}
            />
          </View>

          <View style={[glassCard, styles.card]}>
            <View style={styles.buttonGrid}>
              <GradientButton label="AUTO SCHEDULE" onPress={onAutoSchedule} loading={busy} style={styles.btnWrap} />
              <Pressable style={styles.secondaryBtn} onPress={onAutoSelectVideos}>
                <WandSparkles size={15} color={COLORS.accent} />
                <Text style={[styles.secondaryBtnText, { color: COLORS.accent }]}>AUTO SELECT VIDEOS</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={onSavePlan}>
                <Save size={15} color={COLORS.primary} />
                <Text style={styles.secondaryBtnText}>SAVE AUTOMATION SETTINGS</Text>
              </Pressable>
              <Pressable style={styles.secondaryBtn} onPress={onStartAutomation}>
                <Play size={15} color={COLORS.success} />
                <Text style={[styles.secondaryBtnText, { color: COLORS.success }]}>START AUTOMATION</Text>
              </Pressable>
            </View>
          </View>

          <View style={[glassCard, styles.card]}>
            <View style={styles.slotHeader}>
              <CalendarClock size={18} color={COLORS.primary} />
              <Text style={styles.sectionTitle}>Daily Upload Slots</Text>
              <Text style={styles.slotCount}>{selectedChannelIds.length}</Text>
            </View>
            {selectedChannelIds.length === 0 ? (
              <Text style={styles.emptyText}>Select active channels to configure slots.</Text>
            ) : (
              selectedChannelIds.map((channelId) => {
                const channel = connectedChannels.find((item) => item.id === channelId);
                const plan = (channelSlotPlans[channelId] || slots).slice(0, 5);
                return (
                  <View key={channelId} style={styles.channelCard}>
                    <Text style={styles.channelTitle}>{channel?.name || channelId}</Text>
                    {plan.map((slot) => (
                      <View key={`${channelId}-${slot.slot_number}`} style={styles.slotCard}>
                        <View style={styles.rowBetween}>
                          <Text style={styles.slotTitle}>Slot {slot.slot_number}</Text>
                          <Pressable
                            style={styles.enableBtn}
                            onPress={() => updateChannelSlot(channelId, slot.slot_number, { enabled: slot.enabled === false })}
                          >
                            <Text style={styles.enableText}>{slot.enabled === false ? "[ ] Enable" : "[x] Enable"}</Text>
                          </Pressable>
                        </View>
                        <View style={styles.uploadSection}>
                          <Text style={styles.uploadSectionTitle}>Upload (YouTube API Execution Time)</Text>
                          <Text style={styles.slotLabel}>Upload Date</Text>
                          <TextInput
                            value={slot.upload_date}
                            editable={slot.auto_upload_enabled === false}
                            onChangeText={(value) => updateChannelSlot(channelId, slot.slot_number, { upload_date: value, auto_upload_enabled: false })}
                            style={styles.input}
                          />
                          <Text style={styles.slotLabel}>Upload Time</Text>
                          <TextInput
                            value={slot.upload_time}
                            editable={slot.auto_upload_enabled === false}
                            onChangeText={(value) => updateChannelSlot(channelId, slot.slot_number, { upload_time: value, auto_upload_enabled: false })}
                            style={styles.input}
                          />
                          <Pressable
                            style={styles.modeBtn}
                            onPress={() =>
                              updateChannelSlot(channelId, slot.slot_number, {
                                auto_upload_enabled: !(slot.auto_upload_enabled !== false),
                              })
                            }
                          >
                            <Text style={styles.modeText}>AUTO GENERATE UPLOAD TIME: {slot.auto_upload_enabled !== false ? "ON" : "OFF"}</Text>
                          </Pressable>
                        </View>

                        <View style={styles.publishSection}>
                          <Text style={styles.publishSectionTitle}>Publish Settings</Text>
                          <Text style={styles.slotLabel}>Publish Date</Text>
                          <TextInput value={slot.date} onChangeText={(value) => updateChannelSlot(channelId, slot.slot_number, { date: value })} style={styles.input} />
                          <Text style={styles.slotLabel}>Publish Time</Text>
                          <TextInput value={slot.time} onChangeText={(value) => updateChannelSlot(channelId, slot.slot_number, { time: value })} style={styles.input} />
                        </View>

                        <Text style={styles.slotLabel}>Video Selection</Text>
                        <Pressable style={styles.videoPicker} onPress={() => setPickerTarget({ channelId, slotNumber: slot.slot_number })}>
                          <Clock3 size={15} color={COLORS.blue} />
                          <Text style={styles.videoPickerText} numberOfLines={1}>{slot.video_name || "Select video"}</Text>
                        </Pressable>

                        <Text style={styles.slotLabel}>Title</Text>
                        <TextInput
                          value={slot.title}
                          onChangeText={(value) => updateChannelSlot(channelId, slot.slot_number, { title: value })}
                          style={styles.input}
                        />

                        {validateSlotTiming(slot) ? <Text style={styles.errorText}>{validateSlotTiming(slot)}</Text> : null}
                      </View>
                    ))}
                  </View>
                );
              })
            )}
          </View>

          <View style={{ height: 120 }} />
        </ScrollView>
      </SafeAreaView>

      <Modal visible={activePickerSlot !== null} transparent animationType="fade" onRequestClose={() => setPickerTarget(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Video</Text>
            <ScrollView style={{ maxHeight: 280 }}>
              {videos.map((video) => (
                <Pressable
                  key={video.id}
                  style={styles.videoOption}
                  onPress={() => {
                    if (activePickerSlot && pickerTarget) {
                      updateChannelSlot(pickerTarget.channelId, activePickerSlot.slot_number, {
                        video_id: video.id,
                        video_name: video.name,
                      });
                    }
                    setPickerTarget(null);
                  }}
                >
                  <Sparkles size={14} color={COLORS.accent} />
                  <Text style={styles.videoOptionText} numberOfLines={1}>{video.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.closeBtn} onPress={() => setPickerTarget(null)}>
              <Text style={styles.closeBtnText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
        <Text style={styles.toastText}>{toast}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8 },
  card: { marginBottom: 14 },
  schedulerTitle: { fontSize: 24, fontWeight: "800", color: COLORS.text, fontFamily: "SpaceGrotesk-Bold", marginBottom: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mainTitle: { fontSize: 26, fontWeight: "700", color: COLORS.text, fontFamily: "SpaceGrotesk-Bold" },
  subTitle: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2, marginBottom: 8, fontFamily: "SpaceGrotesk-Regular" },
  metaText: { fontSize: 12, color: COLORS.textSecondary, fontFamily: "SpaceGrotesk-Regular" },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: COLORS.text, fontFamily: "SpaceGrotesk-Bold", marginBottom: 8 },
  sectionLabel: { fontSize: 13, color: COLORS.textSecondary, marginTop: 10, marginBottom: 6, fontFamily: "SpaceGrotesk-SemiBold" },
  input: {
    backgroundColor: COLORS.surfaceSecondary,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
    fontFamily: "SpaceGrotesk-Regular",
  },
  multiLine: { minHeight: 150, textAlignVertical: "top" },
  mediumLine: { minHeight: 100, textAlignVertical: "top" },
  buttonGrid: { gap: 10 },
  tagsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  tagChip: {
    backgroundColor: COLORS.blueMuted,
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.25)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  tagChipText: { color: COLORS.blue, fontSize: 12, fontFamily: "SpaceGrotesk-SemiBold" },
  tagChipActive: { backgroundColor: COLORS.blue },
  tagChipTextActive: { color: "#fff" },
  btnWrap: { width: "100%" },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceSecondary,
    paddingVertical: 12,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  secondaryBtnText: { color: COLORS.primary, fontSize: 12, fontFamily: "SpaceGrotesk-Bold", fontWeight: "700" },
  slotHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  slotCount: { marginLeft: "auto", color: COLORS.primary, fontWeight: "700", fontFamily: "SpaceGrotesk-Bold" },
  emptyText: { color: COLORS.textTertiary, fontFamily: "SpaceGrotesk-Regular" },
  slotCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceSecondary,
    padding: 12,
    marginBottom: 10,
  },
  slotTitle: { fontSize: 16, color: COLORS.text, fontWeight: "700", fontFamily: "SpaceGrotesk-Bold" },
  channelCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    padding: 12,
    marginBottom: 10,
  },
  channelTitle: { fontSize: 18, fontWeight: "700", color: COLORS.text, fontFamily: "SpaceGrotesk-Bold", marginBottom: 8 },
  enableBtn: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border },
  enableText: { color: COLORS.textSecondary, fontSize: 12, fontFamily: "SpaceGrotesk-SemiBold" },
  slotLabel: { fontSize: 12, color: COLORS.textSecondary, marginTop: 8, marginBottom: 5, fontFamily: "SpaceGrotesk-Regular" },
  uploadSection: {
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.25)",
    backgroundColor: COLORS.blueMuted,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  uploadSectionTitle: { color: COLORS.blue, fontFamily: "SpaceGrotesk-Bold", fontSize: 13, marginBottom: 4 },
  publishSection: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 10,
    marginTop: 10,
  },
  publishSectionTitle: { color: COLORS.text, fontFamily: "SpaceGrotesk-Bold", fontSize: 13, marginBottom: 4 },
  errorText: { color: COLORS.danger, marginTop: 8, fontSize: 12, fontFamily: "SpaceGrotesk-SemiBold" },
  modeBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  modeText: { color: COLORS.primary, fontSize: 12, fontFamily: "SpaceGrotesk-Bold" },
  videoPicker: {
    backgroundColor: COLORS.blueMuted,
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.2)",
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  videoPickerText: { flex: 1, color: COLORS.blue, fontSize: 13, fontFamily: "SpaceGrotesk-SemiBold" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { width: "100%", backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 16, padding: 14 },
  modalTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700", fontFamily: "SpaceGrotesk-Bold", marginBottom: 10 },
  videoOption: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  videoOptionText: { flex: 1, color: COLORS.textSecondary, fontSize: 13, fontFamily: "SpaceGrotesk-Regular" },
  closeBtn: { marginTop: 12, alignSelf: "flex-end", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: COLORS.surfaceSecondary },
  closeBtnText: { color: COLORS.text, fontFamily: "SpaceGrotesk-SemiBold" },
  toast: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 96,
    backgroundColor: COLORS.surfaceTertiary,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  toastText: { color: COLORS.text, fontFamily: "SpaceGrotesk-SemiBold", fontSize: 13 },
});
