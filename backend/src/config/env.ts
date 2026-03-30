import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

type EnvValue = {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl?: string;
  pglitePath: string;
  redisUrl?: string;
  queueFilePath: string;
  queuePollMs: number;
  workerConcurrency: number;
  schedulerTickMs: number;
  simulationMode: boolean;
  simulationFailRate: number;
  simulationMinMs: number;
  simulationMaxMs: number;
  youtubeDailyQuotaPerChannel: number;
  youtubeUploadQuotaUnits: number;
  authRequired: boolean;
  jwtSecret: string;
  allowedEmails: string[];
};

let cachedEnv: EnvValue | null = null;

function parseNumber(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean) {
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function loadEnvFiles() {
  const __filename = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(__filename);
  const backendRoot = path.resolve(srcDir, "../../");
  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
    path.join(backendRoot, ".env.local"),
    path.join(backendRoot, ".env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      dotenv.config({ path: file, override: false });
    }
  }
  return backendRoot;
}

export function getEnv(): EnvValue {
  if (cachedEnv) return cachedEnv;
  const backendRoot = loadEnvFiles();
  const dataDir = path.join(backendRoot, "data");
  const allowedEmails = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  cachedEnv = {
    nodeEnv: process.env.NODE_ENV || "development",
    host: process.env.HOST || "127.0.0.1",
    port: parseNumber(process.env.PORT, 8080),
    logLevel: process.env.LOG_LEVEL || "info",
    databaseUrl: process.env.DATABASE_URL || undefined,
    pglitePath: process.env.PGLITE_PATH || path.join(dataDir, "pglite"),
    redisUrl: process.env.REDIS_URL || undefined,
    queueFilePath: process.env.QUEUE_FILE_PATH || path.join(dataDir, "upload-queue.json"),
    queuePollMs: parseNumber(process.env.QUEUE_POLL_MS, 1000),
    workerConcurrency: parseNumber(process.env.WORKER_CONCURRENCY, 2),
    schedulerTickMs: parseNumber(process.env.SCHEDULER_TICK_MS, 15_000),
    simulationMode: parseBool(process.env.SIMULATION_MODE, true),
    simulationFailRate: Math.min(0.9, Math.max(0, parseNumber(process.env.SIMULATION_FAIL_RATE, 0.08))),
    simulationMinMs: Math.max(250, parseNumber(process.env.SIMULATION_MIN_MS, 900)),
    simulationMaxMs: Math.max(500, parseNumber(process.env.SIMULATION_MAX_MS, 3500)),
    youtubeDailyQuotaPerChannel: Math.max(1600, parseNumber(process.env.YOUTUBE_DAILY_QUOTA_PER_CHANNEL, 8000)),
    youtubeUploadQuotaUnits: Math.max(100, parseNumber(process.env.YOUTUBE_UPLOAD_QUOTA_UNITS, 1600)),
    authRequired: parseBool(process.env.AUTH_REQUIRED, false),
    jwtSecret: process.env.JWT_SECRET || "local-dev-jwt-secret-change-in-prod",
    allowedEmails,
  };
  return cachedEnv;
}
