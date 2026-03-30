import { createCoreApp } from "./core/createApp.js";
import { ensureSchema } from "./db/bootstrap.js";
import { initUploadQueue } from "./queue/uploadQueue.js";
import { enqueueDueSchedules } from "./services/uploadPipeline.js";
import { isAutomationRunning } from "./services/automationRuntime.js";
import { getEnv } from "./config/env.js";

async function main() {
  const env = getEnv();
  if (!env.databaseUrl) {
    console.log("Scheduler external mode disabled in fallback DB mode; API process owns scheduler loop");
    setInterval(() => undefined, 60_000);
    return;
  }
  const app = await createCoreApp();
  await ensureSchema(app);
  await initUploadQueue(app);
  app.logger.info({ tickMs: app.env.schedulerTickMs }, "Scheduler started");
  setInterval(async () => {
    try {
      const automationRunning = await isAutomationRunning(app);
      if (!automationRunning) {
        app.logger.info("Scheduler heartbeat: automation is OFF");
        return;
      }
      const result = await enqueueDueSchedules(app);
      app.logger.info({ queued: result.queued }, "Scheduler heartbeat");
    } catch (error) {
      app.logger.error({ err: error }, "Scheduler tick failed");
    }
  }, app.env.schedulerTickMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
