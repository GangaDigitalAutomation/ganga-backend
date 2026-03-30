import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, open, stat } from "node:fs/promises";
import path from "node:path";
import type { App } from "../core/createApp.js";

type QueueMode = "file" | "bullmq";

type FileQueueJob = {
  id: string;
  scheduleId: string;
  runAt: string;
  status: "queued" | "active";
  attemptsMade: number;
  maxAttempts: number;
  lastError?: string;
  updatedAt: string;
};

type FileQueueState = {
  jobs: FileQueueJob[];
  updatedAt: string;
};

type DeadletterJob = {
  id: string;
  scheduleId: string;
  failedAt: string;
  attemptsMade: number;
  error: string;
};

type DeadletterState = {
  jobs: DeadletterJob[];
  updatedAt: string;
};

type BullImports = {
  Queue: any;
  Worker: any;
};

type QueueRuntime = {
  mode: QueueMode;
  queueName: string;
  deadletterQueueName: string;
  queuePath: string;
  deadletterPath: string;
  lockPath: string;
  pollMs: number;
  concurrency: number;
  bull?: {
    queue: any;
    deadletterQueue: any;
    connection: any;
    imports: BullImports;
  };
};

type EnqueueOptions = {
  runAt?: string;
  maxAttempts?: number;
};

type StartWorkerOptions = {
  app: App;
  processSchedule: (scheduleId: string, uploadJobId: string) => Promise<void>;
};

const runtime: QueueRuntime = {
  mode: "file",
  queueName: "upload_execute",
  deadletterQueueName: "upload_deadletter",
  queuePath: "",
  deadletterPath: "",
  lockPath: "",
  pollMs: 1000,
  concurrency: 2,
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = path.dirname(runtime.lockPath);
  await mkdir(lockDir, { recursive: true });

  for (let i = 0; i < 200; i += 1) {
    try {
      const handle = await open(runtime.lockPath, "wx");
      try {
        return await fn();
      } finally {
        await handle.close();
        await rm(runtime.lockPath, { force: true });
      }
    } catch {
      try {
        const lockStat = await stat(runtime.lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(runtime.lockPath, { force: true });
        }
      } catch {
        // ignore transient lock check failures
      }
      await sleep(25);
    }
  }
  throw new Error("Queue lock timeout");
}

async function readQueueFile() {
  await mkdir(path.dirname(runtime.queuePath), { recursive: true });
  try {
    const raw = await readFile(runtime.queuePath, "utf8");
    const parsed = JSON.parse(raw) as FileQueueState;
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch {
    const empty: FileQueueState = { jobs: [], updatedAt: new Date().toISOString() };
    await writeFile(runtime.queuePath, JSON.stringify(empty, null, 2), "utf8");
    return empty;
  }
}

async function writeQueueFile(next: FileQueueState) {
  next.updatedAt = new Date().toISOString();
  await writeFile(runtime.queuePath, JSON.stringify(next, null, 2), "utf8");
}

async function readDeadletterFile() {
  await mkdir(path.dirname(runtime.deadletterPath), { recursive: true });
  try {
    const raw = await readFile(runtime.deadletterPath, "utf8");
    const parsed = JSON.parse(raw) as DeadletterState;
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch {
    const empty: DeadletterState = { jobs: [], updatedAt: new Date().toISOString() };
    await writeFile(runtime.deadletterPath, JSON.stringify(empty, null, 2), "utf8");
    return empty;
  }
}

async function writeDeadletterFile(next: DeadletterState) {
  next.updatedAt = new Date().toISOString();
  await writeFile(runtime.deadletterPath, JSON.stringify(next, null, 2), "utf8");
}

async function addToDeadletter(scheduleId: string, attemptsMade: number, errorMessage: string) {
  if (runtime.mode === "bullmq" && runtime.bull) {
    await runtime.bull.deadletterQueue.add(
      runtime.deadletterQueueName,
      {
        scheduleId,
        failedAt: new Date().toISOString(),
        attemptsMade,
        error: errorMessage,
      },
      { removeOnComplete: 1000 },
    );
    return;
  }

  await withLock(async () => {
    const state = await readDeadletterFile();
    state.jobs.push({
      id: randomUUID(),
      scheduleId,
      failedAt: new Date().toISOString(),
      attemptsMade,
      error: errorMessage,
    });
    if (state.jobs.length > 1000) {
      state.jobs.splice(0, state.jobs.length - 1000);
    }
    await writeDeadletterFile(state);
  });
}

async function initializeBullMq(app: App): Promise<boolean> {
  if (!app.env.redisUrl) return false;
  try {
    const redisModule = (await import("ioredis")) as any;
    const bullModule = await import("bullmq");
    const Redis = redisModule.default || redisModule;
    const connection = new Redis(app.env.redisUrl, { maxRetriesPerRequest: null });
    await connection.ping();
    const queue = new bullModule.Queue(runtime.queueName, { connection });
    const deadletterQueue = new bullModule.Queue(runtime.deadletterQueueName, { connection });
    runtime.mode = "bullmq";
    runtime.bull = {
      queue,
      deadletterQueue,
      connection,
      imports: { Queue: bullModule.Queue, Worker: bullModule.Worker },
    };
    app.logger.info("Queue mode: bullmq");
    return true;
  } catch (error) {
    app.logger.warn({ err: error }, "Redis unavailable, switching to file queue fallback");
    return false;
  }
}

export async function initUploadQueue(app: App) {
  runtime.queuePath = app.env.queueFilePath;
  runtime.deadletterPath = `${runtime.queuePath}.deadletter`;
  runtime.lockPath = `${runtime.queuePath}.lock`;
  runtime.pollMs = app.env.queuePollMs;
  runtime.concurrency = app.env.workerConcurrency;
  await initializeBullMq(app);
}

export function getQueueMode() {
  return runtime.mode;
}

export async function enqueueUploadJob(scheduleId: string, options: EnqueueOptions = {}) {
  const runAt = options.runAt || new Date().toISOString();
  const maxAttempts = options.maxAttempts || 3;

  if (runtime.mode === "bullmq" && runtime.bull) {
    await runtime.bull.queue.add(
      runtime.queueName,
      { scheduleId },
      {
        jobId: scheduleId,
        attempts: maxAttempts,
        backoff: { type: "exponential", delay: 15_000 },
        delay: Math.max(0, new Date(runAt).getTime() - Date.now()),
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );
    return { queueMode: runtime.mode, queued: true };
  }

  return withLock(async () => {
    const state = await readQueueFile();
    const existing = state.jobs.find((job) => job.scheduleId === scheduleId && (job.status === "queued" || job.status === "active"));
    if (existing) {
      return { queueMode: runtime.mode, queued: false };
    }
    state.jobs.push({
      id: randomUUID(),
      scheduleId,
      runAt,
      status: "queued",
      attemptsMade: 0,
      maxAttempts,
      updatedAt: new Date().toISOString(),
    });
    await writeQueueFile(state);
    return { queueMode: runtime.mode, queued: true };
  });
}

export async function recoverStaleJobs(maxActiveAgeMs = 5 * 60 * 1000) {
  if (runtime.mode !== "file") return;
  await withLock(async () => {
    const state = await readQueueFile();
    const now = Date.now();
    for (const job of state.jobs) {
      if (job.status === "active" && now - new Date(job.updatedAt).getTime() > maxActiveAgeMs) {
        job.status = "queued";
        job.updatedAt = new Date().toISOString();
      }
    }
    await writeQueueFile(state);
  });
}

async function fileWorkerLoop(options: StartWorkerOptions) {
  const { app, processSchedule } = options;
  await recoverStaleJobs();

  setInterval(async () => {
    try {
      const jobs = await withLock(async () => {
        const state = await readQueueFile();
        const now = Date.now();
        const due = state.jobs
          .filter((job) => job.status === "queued" && new Date(job.runAt).getTime() <= now)
          .slice(0, runtime.concurrency);
        for (const job of due) {
          job.status = "active";
          job.attemptsMade += 1;
          job.updatedAt = new Date().toISOString();
        }
        await writeQueueFile(state);
        return due;
      });

      for (const job of jobs) {
        try {
          await processSchedule(job.scheduleId, job.id);
          await withLock(async () => {
            const state = await readQueueFile();
            state.jobs = state.jobs.filter((queued) => queued.id !== job.id);
            await writeQueueFile(state);
          });
        } catch (error) {
          let shouldDeadletter = false;
          let deadletterAttempts = 0;
          let deadletterError = "Worker job failed";
          await withLock(async () => {
            const state = await readQueueFile();
            const next = state.jobs.find((queued) => queued.id === job.id);
            if (!next) return;
            if (next.attemptsMade >= next.maxAttempts) {
              state.jobs = state.jobs.filter((queued) => queued.id !== job.id);
              shouldDeadletter = true;
              deadletterAttempts = next.attemptsMade;
              deadletterError = error instanceof Error ? error.message : "Worker job failed";
            } else {
              next.status = "queued";
              next.lastError = error instanceof Error ? error.message : "Unknown worker error";
              next.runAt = new Date(Date.now() + 15_000 * next.attemptsMade).toISOString();
              next.updatedAt = new Date().toISOString();
            }
            await writeQueueFile(state);
          });
          if (shouldDeadletter) {
            await addToDeadletter(job.scheduleId, deadletterAttempts, deadletterError);
          }
          app.logger.error({ err: error, scheduleId: job.scheduleId }, "File queue worker job failed");
        }
      }
    } catch (error) {
      app.logger.error({ err: error }, "File queue worker tick failed");
    }
  }, runtime.pollMs);
}

export async function startUploadWorker(options: StartWorkerOptions) {
  const { app, processSchedule } = options;

  if (runtime.mode === "bullmq" && runtime.bull) {
    const worker = new runtime.bull.imports.Worker(
      runtime.queueName,
      async (job: any) => {
        await processSchedule(job.data.scheduleId, job.id);
      },
      {
        connection: runtime.bull.connection,
        concurrency: runtime.concurrency,
      },
    );
    worker.on("failed", (job: any, error: Error) => {
      app.logger.error({ err: error, scheduleId: job?.data?.scheduleId }, "BullMQ worker job failed");
      const attempts = Number(job?.attemptsMade || 0);
      const maxAttempts = Number(job?.opts?.attempts || 0);
      if (attempts >= maxAttempts) {
        addToDeadletter(
          String(job?.data?.scheduleId || ""),
          attempts,
          error instanceof Error ? error.message : "BullMQ worker job failed",
        ).catch((deadletterError) => {
          app.logger.error({ err: deadletterError }, "Failed to add BullMQ deadletter entry");
        });
      }
    });
    app.logger.info({ concurrency: runtime.concurrency }, "BullMQ worker started");
    return;
  }

  app.logger.info({ pollMs: runtime.pollMs, concurrency: runtime.concurrency }, "File queue worker started");
  await fileWorkerLoop(options);
}
