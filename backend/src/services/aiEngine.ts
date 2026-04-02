import crypto from "node:crypto";
import type { App } from "../index.js";
import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import { generateAutoSchedule, saveContentSettings } from "./autoPlannerEngine.js";
import { setAutomationRunningDb } from "./automationRuntime.js";

type ActionResult = {
  action: string;
  success: boolean;
  message: string;
  data?: any;
};

export async function connectChannel(app: App, channelName: string, clientId: string, clientSecret: string): Promise<ActionResult> {
  const newId = crypto.randomUUID();
  await app.db.insert(schema.channels).values({
    id: newId,
    name: channelName || "Unnamed Channel",
    client_id: clientId || "empty",
    client_secret: clientSecret || "empty",
    status: "disconnected",
    is_starred: false,
    created_at: new Date().toISOString(),
  });
  return {
    action: "connectChannel",
    success: true,
    message: `Added channel "${channelName}". Please complete the Google OAuth process on the Dashboard to fully connect it.`,
  };
}

export async function updateContentSettingsAi(titles?: string[], description?: string, tags?: string[]): Promise<ActionResult> {
  const updated = await saveContentSettings({ titles, description, tags });
  return {
    action: "updateContentSettings",
    success: true,
    message: "Content settings updated successfully.",
    data: updated,
  };
}

export async function startAutomation(app: App): Promise<ActionResult> {
  const runtime = await setAutomationRunningDb(app, true);
  return { action: "startAutomation", success: true, message: "Automation started", data: runtime };
}

export async function stopAutomation(app: App): Promise<ActionResult> {
  const runtime = await setAutomationRunningDb(app, false);
  return { action: "stopAutomation", success: true, message: "Automation stopped", data: runtime };
}

export async function reconnectYouTube(app: App, channelId?: string): Promise<ActionResult> {
  if (!channelId) {
    return { action: "reconnectYouTube", success: false, message: "Channel ID required." };
  }
  const channel = await app.db.query.channels.findFirst({
    where: eq(schema.channels.id, channelId),
  });
  if (!channel) {
    return { action: "reconnectYouTube", success: false, message: "Channel not found." };
  }
  const url = `/auth/google?channelId=${encodeURIComponent(channelId)}`;
  return {
    action: "reconnectYouTube",
    success: true,
    message: "Reconnect URL generated.",
    data: { url },
  };
}

export async function connectGoogleDrive(): Promise<ActionResult> {
  return {
    action: "connectGoogleDrive",
    success: true,
    message: "Open Drive OAuth to connect.",
    data: { url: "/api/drive/auth/start?redirect=1" },
  };
}

export async function fixSchedule(app: App): Promise<ActionResult> {
  const plan = await generateAutoSchedule(app, { replace_existing: true });
  return { action: "fixSchedule", success: true, message: "Schedule regenerated.", data: plan };
}

export async function retryFailedUploads(app: App): Promise<ActionResult> {
  const failed = await app.db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.status, "failed"))
    .orderBy(desc(schema.schedules.created_at));
  if (!failed.length) {
    return { action: "retryFailedUploads", success: true, message: "No failed uploads found." };
  }
  const now = new Date().toISOString();
  await app.db
    .update(schema.schedules)
    .set({ status: "pending", error_message: null, retry_count: 0, created_at: now })
    .where(eq(schema.schedules.status, "failed"));
  return {
    action: "retryFailedUploads",
    success: true,
    message: `Requeued ${failed.length} failed uploads.`,
  };
}

export function detectIntent(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("start automation")) return "startAutomation";
  if (lower.includes("stop automation")) return "stopAutomation";
  if (lower.includes("reconnect youtube")) return "reconnectYouTube";
  if (lower.includes("connect drive")) return "connectGoogleDrive";
  if (lower.includes("fix schedule")) return "fixSchedule";
  if (lower.includes("retry failed")) return "retryFailedUploads";
  if (lower.includes("connect channel")) return "connectChannel";
  return "none";
}
