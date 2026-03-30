import { createCoreApp } from "./core/createApp.js";
import { ensureSchema } from "./db/bootstrap.js";
import { initUploadQueue, startUploadWorker } from "./queue/uploadQueue.js";
import { processScheduleUpload } from "./services/uploadPipeline.js";
import { getEnv } from "./config/env.js";

async function main() {
  const env = getEnv();
  if (!env.databaseUrl) {
    console.log("Worker external mode disabled in fallback DB mode; API process owns worker loop");
    setInterval(() => undefined, 60_000);
    return;
  }
  const app = await createCoreApp();
  await ensureSchema(app);
  await initUploadQueue(app);
  await startUploadWorker({
    app,
    processSchedule: async (scheduleId, uploadJobId) => {
      await processScheduleUpload(app, scheduleId, uploadJobId);
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
