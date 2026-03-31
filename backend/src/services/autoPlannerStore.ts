import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ContentSettings = {
  titles: string[];
  description: string;
  tags: string[];
  videos_per_day: number;
  start_time: string;
};

export type AutomationSettings = {
  auto_schedule_enabled: boolean;
  channel_slot_plans: Record<string, any>;
  slots: any[];
  automation_slots: string[];
  last_saved_at: string;
};

type PlannerStore = {
  content_settings: ContentSettings;
  automation_settings: AutomationSettings;
  rotation: {
    next_video_index: number;
  };
  schedule_titles: Record<string, string>;
};

const DEFAULT_STORE: PlannerStore = {
  content_settings: {
    titles: [],
    description: "",
    tags: [],
    videos_per_day: 5,
    start_time: "04:00",
  },
  automation_settings: {
    auto_schedule_enabled: false,
    channel_slot_plans: {},
    slots: [],
    automation_slots: [],
    last_saved_at: "",
  },
  rotation: {
    next_video_index: 0,
  },
  schedule_titles: {},
};

let lock: Promise<void> = Promise.resolve();

function resolvePlannerPath() {
  if (process.env.AUTO_PLANNER_DB_PATH) {
    return path.resolve(process.cwd(), process.env.AUTO_PLANNER_DB_PATH);
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRootFromSrc = path.resolve(currentDir, "../../../../");
  return path.join(repoRootFromSrc, "database", "auto-planner.json");
}

export const AUTO_PLANNER_PATH = resolvePlannerPath();

async function ensureStoreFile() {
  const dir = path.dirname(AUTO_PLANNER_PATH);
  await mkdir(dir, { recursive: true });
  try {
    await readFile(AUTO_PLANNER_PATH, "utf8");
  } catch {
    await writeFile(AUTO_PLANNER_PATH, JSON.stringify(DEFAULT_STORE, null, 2), "utf8");
  }
}

function normalizeStore(raw: Partial<PlannerStore> | null | undefined): PlannerStore {
  const input = raw ?? {};
  const content = input.content_settings ?? DEFAULT_STORE.content_settings;
  const automation = input.automation_settings ?? DEFAULT_STORE.automation_settings;
  return {
    content_settings: {
      titles: Array.isArray(content.titles) ? content.titles.map((t) => String(t).trim()).filter(Boolean) : [],
      description: String(content.description ?? ""),
      tags: Array.isArray(content.tags) ? content.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      videos_per_day: Number(content.videos_per_day || 5),
      start_time: String(content.start_time || "04:00"),
    },
    automation_settings: {
      auto_schedule_enabled: Boolean(automation.auto_schedule_enabled),
      channel_slot_plans: automation.channel_slot_plans && typeof automation.channel_slot_plans === "object"
        ? automation.channel_slot_plans
        : {},
      slots: Array.isArray(automation.slots) ? automation.slots : [],
      automation_slots: Array.isArray(automation.automation_slots) ? automation.automation_slots : [],
      last_saved_at: String(automation.last_saved_at || ""),
    },
    rotation: {
      next_video_index: Number(input.rotation?.next_video_index || 0),
    },
    schedule_titles: input.schedule_titles ?? {},
  };
}

export async function readPlannerStore(): Promise<PlannerStore> {
  await ensureStoreFile();
  const raw = await readFile(AUTO_PLANNER_PATH, "utf8");
  const parsed = raw ? (JSON.parse(raw) as PlannerStore) : DEFAULT_STORE;
  return normalizeStore(parsed);
}

export async function updatePlannerStore(
  updater: (store: PlannerStore) => void | Promise<void>,
): Promise<PlannerStore> {
  const run = async () => {
    await ensureStoreFile();
    const raw = await readFile(AUTO_PLANNER_PATH, "utf8");
    const parsed = raw ? (JSON.parse(raw) as PlannerStore) : DEFAULT_STORE;
    const normalized = normalizeStore(parsed);
    await updater(normalized);
    await writeFile(AUTO_PLANNER_PATH, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  };
  const next = lock.then(run, run);
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function getScheduleTitle(scheduleId: string): Promise<string | null> {
  const store = await readPlannerStore();
  const title = store.schedule_titles[scheduleId];
  return title ? String(title) : null;
}
