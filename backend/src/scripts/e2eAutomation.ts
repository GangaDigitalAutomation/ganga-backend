import { randomUUID } from "node:crypto";
import { createCoreApp } from "../core/createApp.js";
import { ensureSchema } from "../db/bootstrap.js";
import * as schema from "../db/schema/schema.js";
import { eq } from "drizzle-orm";
import { initUploadQueue, startUploadWorker } from "../queue/uploadQueue.js";
import { enqueueDueSchedules, processScheduleUpload } from "../services/uploadPipeline.js";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function main() {
  const app = await createCoreApp();
  await ensureSchema(app);
  await initUploadQueue(app);
  await startUploadWorker({
    app,
    processSchedule: async (scheduleId, uploadJobId) => processScheduleUpload(app, scheduleId, uploadJobId),
  });

  const userId = randomUUID();
  const channelId = randomUUID();
  const videoId = randomUUID();
  const scheduleId = randomUUID();
  const now = new Date();
  const publishAt = new Date(now.getTime() + 8_000).toISOString();
  const uploadAt = new Date(now.getTime() - 1_000).toISOString();

  await app.db.insert(schema.users).values({
    id: userId,
    email: `e2e-${Date.now()}@example.com`,
    name: "E2E User",
    is_allowed: true,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  await app.db.insert(schema.channels).values({
    id: channelId,
    name: "E2E Channel",
    client_id: "e2e-client",
    client_secret: "e2e-secret",
    status: "connected",
    created_at: now.toISOString(),
  });

  await app.db.insert(schema.videos).values({
    id: videoId,
    name: "E2E Video",
    file_path: "/tmp/e2e-video.mp4",
    size_bytes: 10_000_000,
    extension: "mp4",
    created_at: now.toISOString(),
  });

  await app.db.insert(schema.schedules).values({
    id: scheduleId,
    channel_id: channelId,
    video_id: videoId,
    scheduled_at: publishAt,
    upload_at: uploadAt,
    status: "pending",
    retry_count: 0,
    created_at: now.toISOString(),
  });

  const queued = await enqueueDueSchedules(app);
  if (queued.queued < 1) {
    throw new Error("E2E failed: schedule was not queued");
  }

  const uploaded = await waitFor(async () => {
    const schedule = await app.db.query.schedules.findFirst({ where: eq(schema.schedules.id, scheduleId) });
    return schedule?.status === "uploaded";
  }, 30_000);

  if (!uploaded) {
    throw new Error("E2E failed: schedule did not reach uploaded state");
  }

  const uploadJob = await app.db.query.upload_jobs.findFirst({ where: eq(schema.upload_jobs.schedule_id, scheduleId) });
  if (!uploadJob || uploadJob.status !== "completed") {
    throw new Error("E2E failed: upload_job not completed");
  }

  await sleep(9_000);
  await enqueueDueSchedules(app);
  const published = await waitFor(async () => {
    const schedule = await app.db.query.schedules.findFirst({ where: eq(schema.schedules.id, scheduleId) });
    return schedule?.status === "published";
  }, 15_000);

  if (!published) {
    throw new Error("E2E failed: schedule did not reach published state");
  }

  const events = await app.db
    .select()
    .from(schema.upload_events)
    .where(eq(schema.upload_events.schedule_id, scheduleId));
  const eventTypes = new Set(events.map((event) => event.event_type));
  const required = ["schedule.queued", "upload.started", "upload.completed", "publish.completed"];
  for (const type of required) {
    if (!eventTypes.has(type)) {
      throw new Error(`E2E failed: missing event ${type}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        scheduleId,
        finalScheduleStatus: "published",
        published: true,
        uploadJobStatus: uploadJob.status,
        events: Array.from(eventTypes),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
