import { and, eq, inArray, like } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import type { App } from "../index.js";
import type { ContentSettings } from "./autoPlannerStore.js";
import { readPlannerStore, updatePlannerStore } from "./autoPlannerStore.js";
import { computePublishDelaySeries, computeUploadAtForSchedule, getPublishSlots } from "./humanTiming.js";

type SlotInput = {
  slot_number: number;
  date: string;
  time: string;
  video_id: string;
  title: string;
};

type ConnectedChannel = Awaited<ReturnType<typeof getConnectedChannels>>[number];

type GenerateInput = {
  target_date?: string;
  videos_per_day?: number;
  start_time?: string;
  replace_existing?: boolean;
};

function toDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function tomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toDateString(d);
}

function parseStartTimeToMinutes(startTime: string) {
  const [h, m] = String(startTime || "04:00").split(":").map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 4 * 60;
  return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
}

function minutesToTimeString(minutes: number) {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function localIsoFromDateAndTime(dateStr: string, timeStr: string, minuteOffset = 0) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const d = new Date(year, (month || 1) - 1, day || 1, hour || 0, (minute || 0) + minuteOffset, 0, 0);
  return d.toISOString();
}

function pickTitles(titles: string[], total: number) {
  if (!titles.length) {
    return Array.from({ length: total }, (_, i) => `Auto Upload ${i + 1}`);
  }
  const pool = titles.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: string[] = [];
  for (let i = 0; i < total; i += 1) {
    out.push(pool[i % pool.length]);
  }
  return out;
}

async function getConnectedChannels(app: App) {
  return app.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.status, "connected"));
}

async function getOrderedVideos(app: App) {
  return app.db.select().from(schema.videos);
}

async function clearPendingSchedulesForDate(app: App, date: string, channelIds: string[]) {
  if (!channelIds.length) return;
  await app.db
    .delete(schema.schedules)
    .where(
      and(
        inArray(schema.schedules.channel_id, channelIds),
        like(schema.schedules.scheduled_at, `${date}%`),
        eq(schema.schedules.status, "pending"),
      ),
    );
}

async function persistSchedulesFromSlots(
  app: App,
  slots: SlotInput[],
  channels: ConnectedChannel[],
) {
  const now = new Date().toISOString();
  const values: Array<{
    channel_id: string;
    video_id: string;
    scheduled_at: string;
    publish_at: string;
    slot_no: number;
    upload_at: string;
    status: string;
    retry_count: number;
    created_at: string;
  }> = [];

  slots.forEach((slot) => {
    const publishDelays = computePublishDelaySeries(channels.length);
    channels.forEach((channel, channelIndex) => {
      const publishAt = localIsoFromDateAndTime(slot.date, slot.time, publishDelays[channelIndex] || 0);
      const uploadAt = computeUploadAtForSchedule(publishAt, channelIndex, channels.length);
      values.push({
        channel_id: channel.id,
        video_id: slot.video_id,
        scheduled_at: publishAt,
        publish_at: publishAt,
        slot_no: slot.slot_number,
        upload_at: uploadAt,
        status: "pending",
        retry_count: 0,
        created_at: now,
      });
    });
  });

  const inserted = values.length
    ? await app.db.insert(schema.schedules).values(values).returning()
    : [];

  await updatePlannerStore(async (store) => {
    let idx = 0;
    for (const slot of slots) {
      for (let i = 0; i < channels.length; i += 1) {
        const schedule = inserted[idx];
        if (schedule?.id) {
          store.schedule_titles[schedule.id] = slot.title;
        }
        idx += 1;
      }
    }
  });

  return inserted;
}

export async function getContentSettings() {
  const store = await readPlannerStore();
  return store.content_settings;
}

export async function saveContentSettings(input: Partial<ContentSettings>) {
  const updated = await updatePlannerStore(async (store) => {
    if (input.titles) {
      store.content_settings.titles = input.titles.map((t) => String(t).trim()).filter(Boolean);
    }
    if (input.description !== undefined) {
      store.content_settings.description = String(input.description || "");
    }
    if (input.tags) {
      store.content_settings.tags = input.tags.map((t) => String(t).trim()).filter(Boolean);
    }
    if (input.videos_per_day !== undefined) {
      const vpd = Number(input.videos_per_day);
      store.content_settings.videos_per_day = Number.isFinite(vpd) ? Math.max(1, Math.min(24, vpd)) : 5;
    }
    if (input.start_time !== undefined) {
      store.content_settings.start_time = String(input.start_time || "04:00");
    }
  });
  return updated.content_settings;
}

export async function generateAutoSchedule(app: App, input: GenerateInput = {}) {
  const channels = await getConnectedChannels(app);
  const channelIds = channels.map((c: ConnectedChannel) => c.id);
  if (!channelIds.length) {
    throw new Error("No connected channels found");
  }

  const videos = await getOrderedVideos(app);
  if (!videos.length) {
    throw new Error("No videos found in library");
  }

  const store = await readPlannerStore();
  const settings = store.content_settings;
  const targetDate = input.target_date || tomorrowDate();
  const videosPerDay = Math.max(1, Math.min(24, Number(input.videos_per_day || settings.videos_per_day || 5)));
  const startTime = String(input.start_time || settings.start_time || "04:00");
  const gap = 1440 / videosPerDay;
  const startMinutes = parseStartTimeToMinutes(startTime);
  const safeStartIndex = Math.max(0, store.rotation.next_video_index % videos.length);
  const slotTitles = pickTitles(settings.titles, videosPerDay);
  const fixedSlots = getPublishSlots(videosPerDay);

  if (input.replace_existing !== false) {
    await clearPendingSchedulesForDate(app, targetDate, channelIds);
  }

  const slots: SlotInput[] = [];
  for (let i = 0; i < videosPerDay; i += 1) {
    const video = videos[(safeStartIndex + i) % videos.length];
    const time = fixedSlots[i] || minutesToTimeString(startMinutes + i * gap);
    slots.push({
      slot_number: i + 1,
      date: targetDate,
      time,
      video_id: video.id,
      title: slotTitles[i],
    });
  }

  const inserted = await persistSchedulesFromSlots(app, slots, channels);

  await updatePlannerStore(async (nextStore) => {
    nextStore.rotation.next_video_index = (safeStartIndex + videosPerDay) % videos.length;
    nextStore.content_settings.videos_per_day = videosPerDay;
    nextStore.content_settings.start_time = startTime;
  });

  const videoMap = new Map<string, { id: string; name: string }>(
    videos.map((v: { id: string; name: string }) => [v.id, v]),
  );
  return {
    date: targetDate,
    videos_per_day: videosPerDay,
    start_time: startTime,
    channels: channels.map((c: ConnectedChannel) => ({ id: c.id, name: c.name })),
    slots: slots.map((slot) => {
      const video = videoMap.get(slot.video_id);
      return {
        ...slot,
        video_name: video?.name ?? "Unknown video",
        status: "scheduled",
      };
    }),
    inserted_count: inserted.length,
  };
}

export async function saveManualSlots(app: App, slots: SlotInput[]) {
  if (!slots.length) {
    throw new Error("No slots to save");
  }
  const channels = await getConnectedChannels(app);
  const channelIds = channels.map((c: ConnectedChannel) => c.id);
  if (!channelIds.length) {
    throw new Error("No connected channels found");
  }

  const targetDate = slots[0].date;
  await clearPendingSchedulesForDate(app, targetDate, channelIds);
  const inserted = await persistSchedulesFromSlots(app, slots, channels);
  return { success: true, inserted_count: inserted.length };
}

export async function maybeCreateTomorrowSchedule(app: App) {
  const tomorrow = tomorrowDate();
  const existing = await app.db
    .select()
    .from(schema.schedules)
    .where(
      and(
        like(schema.schedules.scheduled_at, `${tomorrow}%`),
        inArray(schema.schedules.status, ["pending", "uploading"]),
      ),
    );

  if (existing.length > 0) {
    return { created: false, reason: "already_exists" as const };
  }

  await generateAutoSchedule(app, { target_date: tomorrow, replace_existing: false });
  return { created: true as const, reason: "generated" as const };
}
