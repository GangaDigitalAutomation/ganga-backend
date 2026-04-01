import type { FastifyReply, FastifyRequest } from "fastify";
import { desc } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import type { App } from "../index.js";
import { getAutomationSettings } from "../services/autoPlannerEngine.js";
import { getAutomationRuntime } from "../services/automationRuntime.js";

export function registerSystemRoutes(app: App) {
  app.fastify.get("/api/system/data", async (_request: FastifyRequest, reply: FastifyReply) => {
    const channels = await app.db.select().from(schema.channels).orderBy(desc(schema.channels.created_at));
    const videos = await app.db.select().from(schema.videos).orderBy(desc(schema.videos.created_at));
    const runtime = await getAutomationRuntime(app);
    const automationSettings = await getAutomationSettings();
    const logs = await app.db
      .select()
      .from(schema.upload_logs)
      .orderBy(desc(schema.upload_logs.created_at))
      .limit(20);

    const errors = logs.filter((log) => ["error", "warn"].includes(String(log.level || "").toLowerCase()));

    const driveConn = await app.db
      .select()
      .from(schema.drive_oauth_connections)
      .limit(1)
      .then((rows) => rows[0])
      .catch(() => null);

    const apiHealth = {
      youtube: channels.some((c) => c.status === "connected") ? "OK" : "FAIL",
      drive: driveConn ? "OK" : "FAIL",
    };

    return {
      status: "ok",
      channels,
      videos,
      automationStatus: runtime.is_running ? "ON" : "OFF",
      scheduleSlots: automationSettings?.slots || [],
      errors,
      logs,
      apiHealth,
    };
  });
}
