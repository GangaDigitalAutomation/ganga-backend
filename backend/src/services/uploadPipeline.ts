import { randomInt, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { and, eq, isNull, inArray, lte } from "drizzle-orm";
import { google } from "googleapis";
import * as schema from "../db/schema/schema.js";
import type { App } from "../core/createApp.js";
import { enqueueUploadJob, getQueueMode } from "../queue/uploadQueue.js";
import { computeUploadAtForSchedule } from "./humanTiming.js";
import { publishUploadEvent } from "./eventBus.js";
import { decryptToken } from "./tokenCrypto.js";
import { getContentSettings } from "./autoPlannerEngine.js";
import { getScheduleTitle } from "./autoPlannerStore.js";

function jitterMs(minMs: number, maxMs: number) {
  const min = Math.min(minMs, maxMs);
  const max = Math.max(minMs, maxMs);
  return randomInt(min, max + 1);
}

function canUseRealGoogleUpload(channel: any, app: App) {
  if (app.env.simulationMode) return false;
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return false;
  if (!channel?.refresh_token && !channel?.access_token) return false;
  return true;
}

function maybeDecryptToken(raw: string | null | undefined) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (!value.includes(":")) return value;
  try {
    return decryptToken(value);
  } catch {
    return value;
  }
}

function parseDriveFileId(input: string) {
  const value = String(input || "");
  const idFromPath = value.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (idFromPath) return idFromPath;
  const prefixed = value.match(/^drive:\/\/([a-zA-Z0-9_-]+)$/)?.[1];
  if (prefixed) return prefixed;
  try {
    const url = new URL(value);
    const idFromQuery = url.searchParams.get("id");
    if (idFromQuery) return idFromQuery;
  } catch {
    return "";
  }
  return "";
}

class QuotaExceededError extends Error {
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "QuotaExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

async function logEntry(app: App, level: "info" | "error", message: string, scheduleId?: string, channelId?: string) {
  await app.db.insert(schema.upload_logs).values({
    id: randomUUID(),
    schedule_id: scheduleId || null,
    channel_id: channelId || null,
    level,
    message,
    created_at: new Date().toISOString(),
  });
}

async function updateUploadJob(
  app: App,
  args: {
    scheduleId: string;
    status: "queued" | "active" | "completed" | "failed";
    queueMode?: string;
    lastError?: string | null;
    attempts?: number;
    maxAttempts?: number;
    startedAt?: string | null;
    completedAt?: string | null;
  },
) {
  const now = new Date().toISOString();
  const existing = await app.db.query.upload_jobs.findFirst({
    where: eq(schema.upload_jobs.schedule_id, args.scheduleId),
  });
  if (!existing) {
    const [inserted] = await app.db.insert(schema.upload_jobs).values({
      id: randomUUID(),
      schedule_id: args.scheduleId,
      status: args.status,
      attempts: args.attempts ?? 0,
      max_attempts: args.maxAttempts ?? 3,
      queue_mode: args.queueMode || getQueueMode(),
      last_error: args.lastError || null,
      queued_at: now,
      started_at: args.startedAt || null,
      completed_at: args.completedAt || null,
      updated_at: now,
    }).returning();
    return inserted?.id || null;
  }

  await app.db
    .update(schema.upload_jobs)
    .set({
      status: args.status,
      attempts: args.attempts ?? existing.attempts,
      max_attempts: args.maxAttempts ?? existing.max_attempts,
      queue_mode: args.queueMode || existing.queue_mode,
      last_error: args.lastError === undefined ? existing.last_error : args.lastError,
      started_at: args.startedAt === undefined ? existing.started_at : args.startedAt,
      completed_at: args.completedAt === undefined ? existing.completed_at : args.completedAt,
      updated_at: now,
    })
    .where(eq(schema.upload_jobs.id, existing.id));
  return existing.id;
}

export async function enqueueDueSchedules(app: App) {
  await markPublishedSchedules(app);
  const now = new Date();
  const pending = await app.db
    .select({
      id: schema.schedules.id,
      channel_id: schema.schedules.channel_id,
      scheduled_at: schema.schedules.scheduled_at,
      upload_at: schema.schedules.upload_at,
      status: schema.schedules.status,
    })
    .from(schema.schedules)
    .where(and(eq(schema.schedules.status, "pending"), isNull(schema.schedules.youtube_video_id)));

  if (pending.length === 0) {
    return { queued: 0 };
  }

  const channelIds = [...new Set(pending.map((item) => item.channel_id))];
  const channelIndex = new Map(channelIds.map((id, idx) => [id, idx]));
  let queued = 0;

  for (const schedule of pending) {
    const index = channelIndex.get(schedule.channel_id) || 0;
    const uploadAt =
      schedule.upload_at ||
      computeUploadAtForSchedule(schedule.scheduled_at, index, channelIds.length);

    if (!schedule.upload_at) {
      await app.db
        .update(schema.schedules)
        .set({ upload_at: uploadAt })
        .where(eq(schema.schedules.id, schedule.id));
    }

    if (new Date(uploadAt).getTime() > now.getTime()) {
      continue;
    }

    const result = await enqueueUploadJob(schedule.id, { runAt: uploadAt, maxAttempts: 3 });
    if (!result.queued) continue;
    queued += 1;
    await updateUploadJob(app, { scheduleId: schedule.id, status: "queued", queueMode: result.queueMode });
    await publishUploadEvent(app, {
      eventType: "schedule.queued",
      scheduleId: schedule.id,
      payload: { upload_at: uploadAt, queue_mode: result.queueMode },
    });
  }

  return { queued };
}

export async function markPublishedSchedules(app: App) {
  const now = new Date().toISOString();
  const candidates = await app.db
    .select({
      id: schema.schedules.id,
      channel_id: schema.schedules.channel_id,
      youtube_video_id: schema.schedules.youtube_video_id,
    })
    .from(schema.schedules)
    .where(
      and(
        inArray(schema.schedules.status, ["uploaded"]),
        lte(schema.schedules.scheduled_at, now),
        isNull(schema.schedules.error_message),
      ),
    );
  if (candidates.length === 0) return 0;

  for (const item of candidates) {
    await app.db
      .update(schema.schedules)
      .set({ status: "published" })
      .where(eq(schema.schedules.id, item.id));
    await publishUploadEvent(app, {
      eventType: "publish.completed",
      scheduleId: item.id,
      payload: { channel_id: item.channel_id, youtube_video_id: item.youtube_video_id || null },
    });
  }
  return candidates.length;
}

async function simulateUpload(app: App, scheduleId: string, channelId: string, video: any) {
  const duration = jitterMs(app.env.simulationMinMs, app.env.simulationMaxMs);
  const chunks = 4;
  for (let i = 0; i < chunks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(duration / chunks)));
  }
  if (Math.random() < app.env.simulationFailRate) {
    throw new Error(`Simulated upload failure for ${video.name}`);
  }
  return `sim_${scheduleId.slice(0, 8)}_${Date.now().toString(36)}`;
}

async function ensureChannelQuota(app: App, channelId: string) {
  const maxDaily = app.env.youtubeDailyQuotaPerChannel;
  const perUpload = app.env.youtubeUploadQuotaUnits;
  const usageDate = new Date().toISOString().slice(0, 10);
  const existing = await app.db.query.channel_quota_usage.findFirst({
    where: and(eq(schema.channel_quota_usage.channel_id, channelId), eq(schema.channel_quota_usage.usage_date, usageDate)),
  });
  const used = existing?.units_used || 0;
  if (used + perUpload > maxDaily) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(23, 59, 0, 0);
    const retryAfterMs = Math.max(30 * 60 * 1000, next.getTime() - now.getTime());
    throw new QuotaExceededError(
      `Daily quota exceeded for channel ${channelId}. used=${used} max=${maxDaily}`,
      retryAfterMs,
    );
  }

  if (existing) {
    await app.db
      .update(schema.channel_quota_usage)
      .set({
        units_used: used + perUpload,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.channel_quota_usage.id, existing.id));
    return;
  }

  await app.db.insert(schema.channel_quota_usage).values({
    id: randomUUID(),
    channel_id: channelId,
    usage_date: usageDate,
    units_used: perUpload,
    updated_at: new Date().toISOString(),
  });
}

async function realGoogleUpload(app: App, channel: any, schedule: any, video: any, overrideTitle?: string | null) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob";
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials({
    access_token: maybeDecryptToken(channel.access_token),
    refresh_token: maybeDecryptToken(channel.refresh_token),
    expiry_date: channel.token_expiry ? new Date(channel.token_expiry).getTime() : undefined,
  });
  await oauth2.getAccessToken();

  const credentials = oauth2.credentials || {};
  if (credentials.access_token || credentials.expiry_date) {
    await app.db
      .update(schema.channels)
      .set({
        access_token: credentials.access_token || channel.access_token,
        refresh_token: credentials.refresh_token || channel.refresh_token,
        token_expiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : channel.token_expiry,
      })
      .where(eq(schema.channels.id, channel.id));
  }

  const driveFileId = parseDriveFileId(video.file_path);
  const mediaBody = driveFileId
    ? (
        await google.drive({ version: "v3", auth: oauth2 }).files.get(
          { fileId: driveFileId, alt: "media" },
          { responseType: "stream" },
        )
      ).data
    : existsSync(video.file_path)
      ? createReadStream(video.file_path)
      : null;

  if (!mediaBody) {
    throw new Error(`Video source not found for ${video.file_path}. Provide local file path or drive://FILE_ID`);
  }

  const youtube = google.youtube({ version: "v3", auth: oauth2 });
  const contentSettings = await getContentSettings().catch(() => ({
    titles: [],
    description: "",
    tags: [],
    videos_per_day: 5,
    start_time: "04:00",
  }));
  const defaultTags = contentSettings.tags?.length
    ? contentSettings.tags
    : (process.env.YOUTUBE_DEFAULT_TAGS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const description = contentSettings.description || process.env.YOUTUBE_DEFAULT_DESCRIPTION || "";
  const title = overrideTitle || video.name;
  const publishAt = schedule.publish_at || schedule.scheduled_at;
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    uploadType: "resumable",
    requestBody: {
      snippet: {
        title,
        description,
        tags: defaultTags,
      },
      status: {
        privacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "private",
        publishAt,
      },
    },
    media: {
      body: mediaBody as any,
    },
  });

  const youtubeVideoId = response.data.id;
  if (!youtubeVideoId) {
    throw new Error("YouTube API returned no video id");
  }
  return youtubeVideoId;
}

export async function processScheduleUpload(app: App, scheduleId: string, uploadJobId: string) {
  const row = await app.db
    .select({
      schedule: schema.schedules,
      channel: schema.channels,
      video: schema.videos,
    })
    .from(schema.schedules)
    .innerJoin(schema.channels, eq(schema.schedules.channel_id, schema.channels.id))
    .innerJoin(schema.videos, eq(schema.schedules.video_id, schema.videos.id))
    .where(eq(schema.schedules.id, scheduleId))
    .limit(1);

  if (row.length === 0) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }

  const schedule = row[0].schedule;
  const channel = row[0].channel;
  const video = row[0].video;
  const startedAt = new Date().toISOString();

  if (schedule.youtube_video_id || schedule.status === "uploaded" || schedule.status === "published") {
    await updateUploadJob(app, { scheduleId, status: "completed", startedAt, completedAt: startedAt });
    return;
  }

  await app.db
    .update(schema.schedules)
    .set({ status: "uploading", error_message: null })
    .where(eq(schema.schedules.id, scheduleId));
  const uploadJobRef = await updateUploadJob(app, {
    scheduleId,
    status: "active",
    startedAt,
    attempts: (schedule.retry_count || 0) + 1,
  });

  await publishUploadEvent(app, {
    eventType: "upload.started",
    scheduleId,
    uploadJobId: uploadJobRef,
    payload: { channel_id: channel.id, video_name: video.name, simulation_mode: app.env.simulationMode },
  });

  try {
    await ensureChannelQuota(app, channel.id);
    let youtubeVideoId = "";
    if (canUseRealGoogleUpload(channel, app)) {
      const scheduleTitle = await getScheduleTitle(scheduleId);
      youtubeVideoId = await realGoogleUpload(app, channel, schedule, video, scheduleTitle);
    } else {
      youtubeVideoId = await simulateUpload(app, scheduleId, channel.id, video);
    }

    const completedAt = new Date().toISOString();
    await app.db
      .update(schema.schedules)
      .set({
        status: "uploaded",
        youtube_video_id: youtubeVideoId,
        error_message: null,
      })
      .where(eq(schema.schedules.id, scheduleId));
    await updateUploadJob(app, {
      scheduleId,
      status: "completed",
      completedAt,
      lastError: null,
    });

    await logEntry(app, "info", `Upload completed for ${video.name} (${youtubeVideoId})`, scheduleId, channel.id);
    await publishUploadEvent(app, {
      eventType: "upload.completed",
      scheduleId,
      uploadJobId: uploadJobRef,
      payload: { youtube_video_id: youtubeVideoId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upload failure";
    const isQuotaExceeded = error instanceof QuotaExceededError;
    const nextRetry = (schedule.retry_count || 0) + 1;
    const failedHard = isQuotaExceeded ? false : nextRetry >= 3;
    const nextStatus = failedHard ? "failed" : "pending";
    const retryBackoffMs = isQuotaExceeded
      ? error.retryAfterMs
      : Math.min(30 * 60 * 1000, 60_000 * Math.pow(2, Math.max(0, nextRetry - 1)));
    await app.db
      .update(schema.schedules)
      .set({
        status: nextStatus,
        retry_count: nextRetry,
        error_message: message,
      })
      .where(eq(schema.schedules.id, scheduleId));
    await updateUploadJob(app, {
      scheduleId,
      status: failedHard ? "failed" : "queued",
      lastError: message,
      attempts: nextRetry,
    });
    await logEntry(app, "error", `Upload failed for ${video.name}: ${message}`, scheduleId, channel.id);
    await publishUploadEvent(app, {
      eventType: "upload.failed",
      scheduleId,
      uploadJobId: uploadJobRef,
      payload: { error: message, retry_count: nextRetry, failed_hard: failedHard, quota_blocked: isQuotaExceeded },
    });
    if (!failedHard) {
      await enqueueUploadJob(scheduleId, {
        runAt: new Date(Date.now() + retryBackoffMs).toISOString(),
        maxAttempts: 3,
      });
    } else {
      throw error;
    }
  }
}
