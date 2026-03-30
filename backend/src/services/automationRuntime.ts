import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import type { App } from "../core/createApp.js";

async function ensureRuntimeRow(app: App) {
  const existing = await app.db.select().from(schema.automation_runtime).limit(1);
  if (existing.length > 0) return existing[0];
  const now = new Date().toISOString();
  const [created] = await app.db
    .insert(schema.automation_runtime)
    .values({
      id: randomUUID(),
      is_running: false,
      started_at: null,
      stopped_at: now,
      updated_at: now,
    })
    .returning();
  return created;
}

export async function getAutomationRuntime(app: App) {
  return ensureRuntimeRow(app);
}

export async function isAutomationRunning(app: App) {
  const runtime = await ensureRuntimeRow(app);
  return Boolean(runtime.is_running);
}

export async function setAutomationRunningDb(app: App, isRunning: boolean) {
  const runtime = await ensureRuntimeRow(app);
  const now = new Date().toISOString();
  const [updated] = await app.db
    .update(schema.automation_runtime)
    .set({
      is_running: isRunning,
      started_at: isRunning ? now : runtime.started_at,
      stopped_at: isRunning ? runtime.stopped_at : now,
      updated_at: now,
    })
    .where(eq(schema.automation_runtime.id, runtime.id))
    .returning();
  return updated;
}
