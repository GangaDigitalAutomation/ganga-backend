import { randomUUID } from "node:crypto";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerVideoRoutes } from "./routes/videos.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerUploadRoutes } from "./routes/upload.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerAutomationRoutes } from "./routes/automation.js";
import { registerAutoPlannerRoutes } from "./routes/autoPlanner.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDriveRoutes } from "./routes/drive.js";
import { createCoreApp, type App } from "./core/createApp.js";
import * as schema from "./db/schema/schema.js";
import { ensureSchema } from "./db/bootstrap.js";
import { initUploadQueue, startUploadWorker } from "./queue/uploadQueue.js";
import { registerAuthGuard } from "./auth/guard.js";
import { enqueueDueSchedules, processScheduleUpload } from "./services/uploadPipeline.js";
import { isAutomationRunning } from "./services/automationRuntime.js";

const app = await createCoreApp();
export type { App };

await ensureSchema(app);
await initUploadQueue(app);
registerAuthGuard(app);

if (!app.env.databaseUrl) {
  await startUploadWorker({
    app,
    processSchedule: async (scheduleId, uploadJobId) => processScheduleUpload(app, scheduleId, uploadJobId),
  });
  setInterval(async () => {
    try {
      const automationRunning = await isAutomationRunning(app);
      if (!automationRunning) {
        app.logger.info("Embedded scheduler heartbeat: automation is OFF");
        return;
      }
      await enqueueDueSchedules(app);
    } catch (error) {
      app.logger.error({ err: error }, "Embedded scheduler tick failed");
    }
  }, app.env.schedulerTickMs);
  app.logger.info("Embedded worker+scheduler enabled for local fallback mode");
}

registerHealthRoutes(app);
registerEventRoutes(app);
registerAuthRoutes(app);
registerDriveRoutes(app as unknown as App);
registerChannelRoutes(app as unknown as App);
registerVideoRoutes(app as unknown as App);
registerScheduleRoutes(app as unknown as App);
registerUploadRoutes(app as unknown as App);
registerLogsRoutes(app as unknown as App);
registerAutomationRoutes(app as unknown as App);
registerAutoPlannerRoutes(app as unknown as App);

await seedData(app);

if (process.env.START_API !== "false") {
  await app.run();
}

async function seedData(appRef: App) {
  try {
    const existingChannels = await appRef.db.select().from(schema.channels).limit(1);
    if (existingChannels.length > 0) {
      appRef.logger.info("Seed data already exists, skipping");
      return;
    }

    appRef.logger.info("Seeding initial channel/video data");

    await appRef.db.insert(schema.channels).values([
      {
        id: randomUUID(),
        name: "Tech Reviews Channel",
        client_id: "sample-client-id-1",
        client_secret: "sample-client-secret-1",
        status: "connected",
        is_starred: false,
        created_at: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        name: "Gaming Highlights",
        client_id: "sample-client-id-2",
        client_secret: "sample-client-secret-2",
        status: "connected",
        is_starred: false,
        created_at: new Date().toISOString(),
      },
    ]);

    await appRef.db.insert(schema.videos).values([
      {
        id: randomUUID(),
        name: "Top 10 Gadgets 2024",
        file_path: "/videos/top10_gadgets_2024.mp4",
        size_bytes: 524288000,
        extension: "mp4",
        created_at: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        name: "iPhone 16 Review",
        file_path: "/videos/iphone16_review.mp4",
        size_bytes: 314572800,
        extension: "mp4",
        created_at: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        name: "Best Gaming Moments",
        file_path: "/videos/best_gaming_moments.mkv",
        size_bytes: 786432000,
        extension: "mkv",
        created_at: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        name: "Unboxing Samsung S24",
        file_path: "/videos/samsung_s24_unboxing.mp4",
        size_bytes: 209715200,
        extension: "mp4",
        created_at: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        name: "Epic Fails Compilation",
        file_path: "/videos/epic_fails_compilation.mov",
        size_bytes: 419430400,
        extension: "mov",
        created_at: new Date().toISOString(),
      },
    ]);

    appRef.logger.info("Seed data inserted");
  } catch (error) {
    appRef.logger.error({ err: error }, "Seed data failed");
  }
}
