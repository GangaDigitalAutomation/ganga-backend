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
import { CalendarClock, Clock3, Play, Save, WandSparkles } from "lucide-react-native";
import { COLORS, glassCard } from "@/constants/AppColors";
import { GradientButton } from "@/components/GradientButton";
import { apiGet, apiPost, apiPut } from "@/utils/api";

type Channel = { id: string; name: string; status: "connected" | "disconnected" | "error" };
type VideoFile = { id: string; name: string; file_path: string; size_bytes: number; extension: string };
type ContentSettings = {
  titles: string[];
  description: string;
  tags: string[];
  videos_per_day: number;
  start_time: string;
};
type UploadStatus = {
  is_running: boolean;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  progress_percent: number;
};
type SlotItem = {
  slot_number: number;
  time: string;
  date: string;
  video_id: string;
  video_name: string;
  title: string;
  upload_date: string;
  upload_time: string;
  manual_upload_time: boolean;
  upload_mode?: "auto" | "manual";
  status: "scheduled" | "pending";
};
type AutoScheduleResponse = {
  success: boolean;
  plan?: { slots: SlotItem[] };
  error?: string;
};
type SchedulesResponse = {
  schedules: Array<{
    id: string;
    slot_no?: number | null;
    scheduled_at: string;
    upload_at?: string | null;
    video_id: string;
    status: string;
    video?: { name?: string } | null;
  }>;
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

function randomTitles(titles: string[], count: number) {
  if (!titles.length) return Array.from({ length: count }, (_, i) => `Auto Upload ${i + 1}`);
  const pool = [...titles];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}

function deriveUploadDateTime(date: string, time: string, slotNumber: number) {
  const [y, m, d] = String(date || "").split("-").map(Number);
  const [hh, mm] = String(time || "04:00").split(":").map(Number);
  const publish = new Date(y, (m || 1) - 1, d || 1, hh || 4, mm || 0, 0, 0);
  if (Number.isNaN(publish.getTime())) {
    return { upload_date: date, upload_time: "16:00" };
  }
  const shiftHours = [12, 7, 4, 2, 1][Math.max(0, Math.min(4, slotNumber - 1))];
  publish.setHours(publish.getHours() - shiftHours);
  return {
    upload_date: publish.toISOString().slice(0, 10),
    upload_time: `${String(publish.getHours()).padStart(2, "0")}:${String(publish.getMinutes()).padStart(2, "0")}`,
  };
}

function ensureSlotUploadFields(slot: Partial<SlotItem> & { slot_number: number; date: string; time: string }): SlotItem {
  const fallback = deriveUploadDateTime(slot.date, slot.time, slot.slot_number);
  const manual = Boolean(slot.manual_upload_time);
  return {
    slot_number: slot.slot_number,
    time: String(slot.time || ""),
    date: String(slot.date || ""),
    video_id: String(slot.video_id || ""),
    video_name: String(slot.video_name || "No video selected"),
    title: String(slot.title || ""),
    upload_date: String(slot.upload_date || fallback.upload_date),
    upload_time: String(slot.upload_time || fallback.upload_time),
    manual_upload_time: manual,
    upload_mode: manual ? "manual" : "auto",
    status: (slot.status as "scheduled" | "pending") || "scheduled",
  };
}

function buildSlots(input: {
  videosPerDay: number;
  startTime: string;
  date: string;
  videos: VideoFile[];
  titles: string[];
  offset: number;
}) {
  const count = Math.max(1, Math.min(24, Number(input.videosPerDay || 1)));
  const gap = 1440 / count;
  const base = parseStartMinutes(input.startTime);
  const titles = randomTitles(input.titles, count);
  const rows: SlotItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const v = input.videos.length ? input.videos[(input.offset + i) % input.videos.length] : null;
    rows.push({
      slot_number: i + 1,
      time: toTimeString(base + i * gap),
      date: input.date,
      video_id: v?.id || "",
      video_name: v?.name || "No video selected",
      title: titles[i],
      ...deriveUploadDateTime(input.date, toTimeString(base + i * gap), i + 1),
      manual_upload_time: false,
      upload_mode: "auto",
      status: "scheduled",
    });
  }
  return rows;
}

export default function DashboardScreen() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoOffset, setVideoOffset] = useState(0);
  const [pickerSlotNo, setPickerSlotNo] = useState<number | null>(null);

  const [titlesInput, setTitlesInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [tagList, setTagList] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [videosPerDayInput, setVideosPerDayInput] = useState("5");
  const [startTimeInput, setStartTimeInput] = useState("04:00");
  const [targetDateInput, setTargetDateInput] = useState(tomorrowDate());

  const toastOpacity = useRef(new Animated.Value(0)).current;
  const [toast, setToast] = useState("");

  const connectedChannels = useMemo(
    () => channels.filter((c) => c.status === "connected"),
    [channels],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 170, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(toastOpacity, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]).start();
  }, [toastOpacity]);

  const fetchAll = useCallback(async () => {
    try {
      const [ch, vids, settings, up, schedules] = await Promise.all([
        apiGet<{ channels: Channel[] }>("/api/channels"),
        apiGet<{ videos: VideoFile[] }>("/api/videos"),
        apiGet<{ settings: ContentSettings }>("/api/content-settings"),
        apiGet<UploadStatus>("/api/upload/status").catch(() => null as any),
        apiGet<SchedulesResponse>("/api/schedules").catch(() => ({ schedules: [] })),
      ]);
      const channelList = Array.isArray(ch?.channels) ? ch.channels : [];
      const videoList = Array.isArray(vids?.videos) ? vids.videos : [];
      const s = settings?.settings;

      setChannels(channelList);
      setVideos(videoList);
      setUploadStatus(up);
      setVideosPerDayInput(String(s?.videos_per_day || 5));
      setStartTimeInput(s?.start_time || "04:00");
      setTitlesInput((s?.titles || []).join("\n"));
      setDescriptionInput(s?.description || "");
      setTagList(Array.isArray(s?.tags) ? s.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : []);

      const mappedSlots = (schedules?.schedules || [])
        .map((row) => {
          const publish = new Date(row.scheduled_at);
          const upload = row.upload_at ? new Date(row.upload_at) : null;
          return ensureSlotUploadFields({
            slot_number: Number(row.slot_no || 0) || 1,
            date: publish.toISOString().slice(0, 10),
            time: publish.toISOString().slice(11, 16),
            video_id: row.video_id,
            video_name: row.video?.name || "Unknown video",
            title: row.video?.name || "",
            upload_date: upload ? upload.toISOString().slice(0, 10) : undefined,
            upload_time: upload ? upload.toISOString().slice(11, 16) : undefined,
            manual_upload_time: false,
            status: row.status === "pending" ? "pending" : "scheduled",
          });
        })
        .sort((a, b) => a.slot_number - b.slot_number);
      setSlots(mappedSlots);
    } catch (error) {
      console.error("[AutomationPanel] fetch failed", error);
      showToast("Failed to load automation panel");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast, targetDateInput]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const saveContentSettings = async () => {
    const titles = titlesInput.split("\n").map((t) => t.trim()).filter(Boolean);
    const tags = tagList.map((t) => t.trim()).filter(Boolean);
    await apiPut("/api/content-settings", {
      titles,
      description: descriptionInput,
      tags,
      videos_per_day: Math.max(1, Math.min(24, Number(videosPerDayInput || 5))),
      start_time: /^\d{2}:\d{2}$/.test(startTimeInput) ? startTimeInput : "04:00",
    });
  };

  const handleAutoSelectVideos = () => {
    if (!videos.length) {
      showToast("No videos available");
      return;
    }
    setVideoOffset((prev) => (prev + Math.max(1, slots.length)) % videos.length);
    showToast("Videos auto-selected");
  };

  const handleAutoSchedule = async () => {
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
      const res = await apiPost<AutoScheduleResponse>("/api/auto-schedule", {
        target_date: targetDateInput,
        videos_per_day: Number(videosPerDayInput || 5),
        start_time: startTimeInput,
      });
      if (!res?.success) throw new Error(res?.error || "Auto schedule failed");
      const nextSlots = res.plan?.slots || [];
      console.log("[AutomationPanel] backend slots:", nextSlots.length, nextSlots);
      setSlots(nextSlots.map((slot) => ensureSlotUploadFields(slot)));
      showToast(`Auto scheduled ${nextSlots.length} slots`);
    } catch (error: any) {
      console.error("[AutomationPanel] auto schedule failed", error);
      showToast(error?.message || "Auto schedule failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSavePlan = async () => {
    if (!slots.length) {
      showToast("No slots to save");
      return;
    }
    setBusy(true);
    try {
      await saveContentSettings();
      await apiPost("/api/auto-schedule/save", {
        slots: slots.map((s) => ({
          slot_number: s.slot_number,
          publish_date: s.date,
          publish_time: s.time,
          time: s.time,
          date: s.date,
          video_id: s.video_id,
          title: s.title,
          upload_date: s.upload_date,
          upload_time: s.upload_time,
          manual_upload_time: s.manual_upload_time,
        })),
      });
      showToast("Plan saved");
    } catch (error) {
      console.error("[AutomationPanel] save plan failed", error);
      showToast("Failed to save plan");
    } finally {
      setBusy(false);
    }
  };

  const handleStartAutomation = async () => {
    setBusy(true);
    try {
      await apiPost("/api/upload/start");
      const status = await apiGet<UploadStatus>("/api/upload/status");
      setUploadStatus(status);
      showToast("Automation started");
    } catch (error: any) {
      console.error("[AutomationPanel] start automation failed", error);
      showToast(error?.message || "Start failed");
    } finally {
      setBusy(false);
    }
  };

  const updateSlot = (slotNo: number, patch: Partial<SlotItem>) => {
    setSlots((prev) => prev.map((s) => (s.slot_number === slotNo ? { ...s, ...patch } : s)));
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

  const pickerSlot = pickerSlotNo ? slots.find((s) => s.slot_number === pickerSlotNo) : null;

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={["top"]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAll(); }} tintColor={COLORS.primary} />}
          showsVerticalScrollIndicator
        >
          <View style={[glassCard, styles.card]}>
            <Text style={styles.title}>Automation Panel</Text>
            <Text style={styles.sub}>Slot-based scheduler is active and editable</Text>
            <Text style={styles.statusText}>Automation Running: {uploadStatus?.is_running ? "YES" : "NO"}</Text>
            <Text style={styles.statusText}>Pending: {uploadStatus?.pending ?? 0} | Completed: {uploadStatus?.completed ?? 0}</Text>
            <Text style={styles.statusText}>Connected Channels: {connectedChannels.length}</Text>
          </View>

          <View style={[glassCard, styles.card]}>
            <Text style={styles.sectionTitle}>Videos Per Day</Text>
            <TextInput value={videosPerDayInput} onChangeText={setVideosPerDayInput} style={styles.input} keyboardType="number-pad" />
            <Text style={styles.label}>Start Time (HH:MM)</Text>
            <TextInput value={startTimeInput} onChangeText={setStartTimeInput} style={styles.input} />
            <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
            <TextInput value={targetDateInput} onChangeText={setTargetDateInput} style={styles.input} />
          </View>

          <View style={[glassCard, styles.card]}>
            <Text style={styles.sectionTitle}>Content Settings</Text>
            <Text style={styles.label}>Titles (one per line)</Text>
            <TextInput multiline value={titlesInput} onChangeText={setTitlesInput} style={[styles.input, styles.bigBox]} />
            <Text style={styles.label}>Description</Text>
            <TextInput multiline value={descriptionInput} onChangeText={setDescriptionInput} style={[styles.input, styles.midBox]} />
            <Text style={styles.label}>Tags</Text>
            <View style={styles.tagsWrap}>
              {tagList.map((tag) => (
                <Pressable key={tag} style={styles.tagChip} onPress={() => removeTag(tag)}>
                  <Text style={styles.tagChipText}>{tag}  ×</Text>
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
            />
          </View>

          <View style={[glassCard, styles.card]}>
            <View style={styles.buttonCol}>
              <GradientButton label="AUTO SCHEDULE" onPress={handleAutoSchedule} loading={busy} style={{ width: "100%" }} />
              <Pressable style={styles.actionBtn} onPress={handleAutoSelectVideos}>
                <WandSparkles size={15} color={COLORS.accent} />
                <Text style={[styles.actionText, { color: COLORS.accent }]}>AUTO SELECT VIDEOS</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={handleSavePlan}>
                <Save size={15} color={COLORS.primary} />
                <Text style={styles.actionText}>SAVE PLAN</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={handleStartAutomation}>
                <Play size={15} color={COLORS.success} />
                <Text style={[styles.actionText, { color: COLORS.success }]}>START AUTOMATION</Text>
              </Pressable>
            </View>
          </View>

          <View style={[glassCard, styles.card]}>
            <View style={styles.slotHeader}>
              <CalendarClock size={18} color={COLORS.primary} />
              <Text style={styles.sectionTitle}>Slots</Text>
              <Text style={styles.slotCount}>{slots.length}</Text>
            </View>
            {loading ? (
              <Text style={styles.empty}>Loading...</Text>
            ) : slots.length === 0 ? (
              <Text style={styles.empty}>No slots visible.</Text>
            ) : (
              slots.map((slot) => (
                <View key={slot.slot_number} style={styles.slotCard}>
                  <Text style={styles.slotTitle}>Slot {slot.slot_number}</Text>
                  <Text style={styles.label}>Publish Time</Text>
                  <TextInput value={slot.time} onChangeText={(v) => updateSlot(slot.slot_number, { time: v })} style={styles.input} />
                  <Text style={styles.label}>Publish Date</Text>
                  <TextInput value={slot.date} onChangeText={(v) => updateSlot(slot.slot_number, { date: v })} style={styles.input} />
                  <Text style={styles.label}>Upload Mode</Text>
                  <Pressable
                    style={styles.modeBtn}
                    onPress={() =>
                      updateSlot(slot.slot_number, {
                        manual_upload_time: !slot.manual_upload_time,
                        upload_mode: slot.manual_upload_time ? "auto" : "manual",
                      })
                    }
                  >
                    <Text style={styles.modeText}>{slot.manual_upload_time ? "MANUAL" : "AUTO"}</Text>
                  </Pressable>
                  <Text style={styles.label}>Upload Time</Text>
                  <TextInput
                    value={slot.upload_time}
                    editable={slot.manual_upload_time}
                    onChangeText={(v) => updateSlot(slot.slot_number, { upload_time: v, manual_upload_time: true, upload_mode: "manual" })}
                    style={styles.input}
                  />
                  <Text style={styles.label}>Upload Date</Text>
                  <TextInput
                    value={slot.upload_date}
                    editable={slot.manual_upload_time}
                    onChangeText={(v) => updateSlot(slot.slot_number, { upload_date: v, manual_upload_time: true, upload_mode: "manual" })}
                    style={styles.input}
                  />
                  <Text style={styles.label}>Video</Text>
                  <Pressable style={styles.videoBtn} onPress={() => setPickerSlotNo(slot.slot_number)}>
                    <Clock3 size={15} color={COLORS.blue} />
                    <Text style={styles.videoText} numberOfLines={1}>{slot.video_name}</Text>
                  </Pressable>
                  <Text style={styles.label}>Title</Text>
                  <TextInput value={slot.title} onChangeText={(v) => updateSlot(slot.slot_number, { title: v })} style={styles.input} />
                </View>
              ))
            )}
          </View>
          <View style={{ height: 120 }} />
        </ScrollView>
      </SafeAreaView>

      <Modal visible={pickerSlot !== null} transparent animationType="fade" onRequestClose={() => setPickerSlotNo(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Video</Text>
            <ScrollView style={{ maxHeight: 280 }}>
              {videos.map((video) => (
                <Pressable
                  key={video.id}
                  style={styles.videoOption}
                  onPress={() => {
                    if (pickerSlot) updateSlot(pickerSlot.slot_number, { video_id: video.id, video_name: video.name });
                    setPickerSlotNo(null);
                  }}
                >
                  <Text style={styles.videoOptionText} numberOfLines={1}>{video.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.closeBtn} onPress={() => setPickerSlotNo(null)}>
              <Text style={styles.closeText}>Close</Text>
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
  title: { fontSize: 26, fontWeight: "700", color: COLORS.text, fontFamily: "SpaceGrotesk-Bold" },
  sub: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2, marginBottom: 8, fontFamily: "SpaceGrotesk-Regular" },
  statusText: { fontSize: 13, color: COLORS.textSecondary, fontFamily: "SpaceGrotesk-Regular" },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: COLORS.text, fontFamily: "SpaceGrotesk-Bold", marginBottom: 8 },
  label: { fontSize: 12, color: COLORS.textSecondary, marginTop: 8, marginBottom: 5, fontFamily: "SpaceGrotesk-Regular" },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
    fontFamily: "SpaceGrotesk-Regular",
  },
  bigBox: { minHeight: 140, textAlignVertical: "top" },
  midBox: { minHeight: 100, textAlignVertical: "top" },
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
  buttonCol: { gap: 10 },
  actionBtn: {
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
  actionText: { color: COLORS.primary, fontFamily: "SpaceGrotesk-Bold", fontWeight: "700", fontSize: 12 },
  slotHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  slotCount: { marginLeft: "auto", color: COLORS.primary, fontWeight: "700", fontFamily: "SpaceGrotesk-Bold" },
  empty: { color: COLORS.textTertiary, fontFamily: "SpaceGrotesk-Regular" },
  slotCard: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceSecondary,
    padding: 12,
    marginBottom: 10,
  },
  slotTitle: { fontSize: 16, color: COLORS.text, fontWeight: "700", fontFamily: "SpaceGrotesk-Bold" },
  modeBtn: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  modeText: { color: COLORS.primary, fontSize: 12, fontFamily: "SpaceGrotesk-Bold" },
  videoBtn: {
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.2)",
    backgroundColor: COLORS.blueMuted,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  videoText: { flex: 1, color: COLORS.blue, fontSize: 13, fontFamily: "SpaceGrotesk-SemiBold" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: { width: "100%", backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 16, padding: 14 },
  modalTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700", fontFamily: "SpaceGrotesk-Bold", marginBottom: 10 },
  videoOption: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.divider },
  videoOptionText: { color: COLORS.textSecondary, fontSize: 13, fontFamily: "SpaceGrotesk-Regular" },
  closeBtn: { alignSelf: "flex-end", marginTop: 12, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: COLORS.surfaceSecondary },
  closeText: { color: COLORS.text, fontFamily: "SpaceGrotesk-SemiBold" },
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
