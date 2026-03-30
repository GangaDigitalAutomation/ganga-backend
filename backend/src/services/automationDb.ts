import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ChannelRecord = {
  id: string;
  channel_name: string;
  access_token: string;
  refresh_token: string;
  expiry_date: string;
  oauth_state?: string | null;
  created_at: string;
  updated_at: string;
};

export type VideoRecord = {
  id: string;
  drive_file_id: string;
  drive_link: string;
  title: string;
  description: string;
  tags: string[];
  status: "pending" | "uploaded";
  upload_count: number;
  created_at: string;
  updated_at: string;
  uploaded_at?: string | null;
  youtube_video_id?: string | null;
};

export type AutomationState = {
  is_running: boolean;
  updated_at: string | null;
  started_at: string | null;
  stopped_at: string | null;
};

type AutomationDatabase = {
  channels: ChannelRecord[];
  videos: VideoRecord[];
  automation: AutomationState;
};

const DEFAULT_DB: AutomationDatabase = {
  channels: [],
  videos: [],
  automation: {
    is_running: false,
    updated_at: null,
    started_at: null,
    stopped_at: null,
  },
};

let lock: Promise<void> = Promise.resolve();

function resolveDatabasePath() {
  if (process.env.AUTOMATION_DB_PATH) {
    return path.resolve(process.cwd(), process.env.AUTOMATION_DB_PATH);
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRootFromSrc = path.resolve(currentDir, "../../../../");
  const candidateA = path.join(repoRootFromSrc, "database", "automation-db.json");
  return candidateA;
}

const DATABASE_PATH = resolveDatabasePath();

async function ensureDatabaseFile() {
  const dir = path.dirname(DATABASE_PATH);
  await mkdir(dir, { recursive: true });
  try {
    await readFile(DATABASE_PATH, "utf8");
  } catch {
    await writeFile(DATABASE_PATH, JSON.stringify(DEFAULT_DB, null, 2), "utf8");
  }
}

async function withDbMutation<T>(fn: (db: AutomationDatabase) => T | Promise<T>): Promise<T> {
  const run = async () => {
    await ensureDatabaseFile();
    const raw = await readFile(DATABASE_PATH, "utf8");
    const db = raw ? (JSON.parse(raw) as AutomationDatabase) : structuredClone(DEFAULT_DB);

    const normalized: AutomationDatabase = {
      channels: Array.isArray(db.channels) ? db.channels : [],
      videos: Array.isArray(db.videos) ? db.videos : [],
      automation: {
        is_running: db.automation?.is_running ?? false,
        updated_at: db.automation?.updated_at ?? null,
        started_at: db.automation?.started_at ?? null,
        stopped_at: db.automation?.stopped_at ?? null,
      },
    };

    const result = await fn(normalized);
    await writeFile(DATABASE_PATH, JSON.stringify(normalized, null, 2), "utf8");
    return result;
  };

  const next = lock.then(run, run);
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function readAutomationDb(): Promise<AutomationDatabase> {
  await ensureDatabaseFile();
  const raw = await readFile(DATABASE_PATH, "utf8");
  const db = raw ? (JSON.parse(raw) as AutomationDatabase) : structuredClone(DEFAULT_DB);
  return {
    channels: Array.isArray(db.channels) ? db.channels : [],
    videos: Array.isArray(db.videos) ? db.videos : [],
    automation: {
      is_running: db.automation?.is_running ?? false,
      updated_at: db.automation?.updated_at ?? null,
      started_at: db.automation?.started_at ?? null,
      stopped_at: db.automation?.stopped_at ?? null,
    },
  };
}

export async function upsertChannel(channel: ChannelRecord) {
  await withDbMutation(async (db) => {
    const idx = db.channels.findIndex((c) => c.id === channel.id);
    if (idx >= 0) {
      db.channels[idx] = channel;
    } else {
      db.channels.push(channel);
    }
  });
}

export async function updateChannel(channelId: string, updates: Partial<ChannelRecord>) {
  await withDbMutation(async (db) => {
    const idx = db.channels.findIndex((c) => c.id === channelId);
    if (idx < 0) {
      return;
    }
    db.channels[idx] = {
      ...db.channels[idx],
      ...updates,
      updated_at: new Date().toISOString(),
    };
  });
}

export async function addVideo(video: VideoRecord) {
  await withDbMutation(async (db) => {
    db.videos.push(video);
  });
}

export async function updateVideo(videoId: string, updates: Partial<VideoRecord>) {
  await withDbMutation(async (db) => {
    const idx = db.videos.findIndex((v) => v.id === videoId);
    if (idx < 0) {
      return;
    }
    db.videos[idx] = {
      ...db.videos[idx],
      ...updates,
      updated_at: new Date().toISOString(),
    };
  });
}

export async function setAutomationRunning(isRunning: boolean) {
  await withDbMutation(async (db) => {
    const now = new Date().toISOString();
    db.automation = {
      is_running: isRunning,
      updated_at: now,
      started_at: isRunning ? now : db.automation.started_at || null,
      stopped_at: isRunning ? db.automation.stopped_at || null : now,
    };
  });
}

export { DATABASE_PATH };
