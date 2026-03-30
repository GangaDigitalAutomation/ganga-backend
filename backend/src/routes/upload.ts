import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import type { App } from "../core/createApp.js";
import { enqueueDueSchedules } from "../services/uploadPipeline.js";
import { maybeCreateTomorrowSchedule } from "../services/autoPlannerEngine.js";
import { getQueueMode } from "../queue/uploadQueue.js";
import { getAutomationRuntime, setAutomationRunningDb } from "../services/automationRuntime.js";

export function registerUploadRoutes(app: App) {
  app.fastify.get("/api/upload/status", async () => {
    const [totals] = await app.db
      .select({
        total: sql<number>`count(*)`,
        completed: sql<number>`count(*) filter (where ${schema.schedules.status} in ('uploaded','published'))`,
        published: sql<number>`count(*) filter (where ${schema.schedules.status} = 'published')`,
        failed: sql<number>`count(*) filter (where ${schema.schedules.status} = 'failed')`,
        pending: sql<number>`count(*) filter (where ${schema.schedules.status} in ('pending','uploading'))`,
      })
      .from(schema.schedules);

    const total = totals?.total || 0;
    const completed = totals?.completed || 0;
    const published = totals?.published || 0;
    const failed = totals?.failed || 0;
    const pending = totals?.pending || 0;
    const runtime = await getAutomationRuntime(app);
    const isRunning = Boolean(runtime.is_running);
    const progress = total > 0 ? (completed / total) * 100 : 0;
    const today = new Date().toISOString().slice(0, 10);
    const detailRows = await app.db
      .select({
        channel_id: schema.schedules.channel_id,
        slot_no: schema.schedules.slot_no,
        status: schema.schedules.status,
        publish_at: schema.schedules.publish_at,
      })
      .from(schema.schedules);
    const uploadedToday = detailRows.filter(
      (row) => row.status === "uploaded" && String(row.publish_at || "").startsWith(today),
    ).length;

    const perChannelProgress: Record<string, { total: number; uploaded: number }> = {};
    const slotStatus: Record<string, { total: number; uploaded: number; pending: number; failed: number }> = {};
    for (const row of detailRows) {
      const channel = row.channel_id;
      if (!perChannelProgress[channel]) {
        perChannelProgress[channel] = { total: 0, uploaded: 0 };
      }
      perChannelProgress[channel].total += 1;
      if (row.status === "uploaded") {
        perChannelProgress[channel].uploaded += 1;
      }

      const slotKey = String(row.slot_no || 0);
      if (!slotStatus[slotKey]) {
        slotStatus[slotKey] = { total: 0, uploaded: 0, pending: 0, failed: 0 };
      }
      slotStatus[slotKey].total += 1;
      if (row.status === "uploaded") slotStatus[slotKey].uploaded += 1;
      if (row.status === "failed") slotStatus[slotKey].failed += 1;
      if (row.status === "pending" || row.status === "uploading") slotStatus[slotKey].pending += 1;
    }

    return {
      is_running: isRunning,
      total,
      completed,
      published,
      failed,
      pending,
      uploaded_today: uploadedToday,
      per_channel_progress: perChannelProgress,
      slot_status: slotStatus,
      progress_percent: Number(progress.toFixed(2)),
      queue_mode: getQueueMode(),
      simulation_mode: app.env.simulationMode,
    };
  });

  app.fastify.post("/api/upload/start", async (_request: FastifyRequest, reply: FastifyReply) => {
    await setAutomationRunningDb(app, true);
    const connectedChannels = await app.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.status, "connected"))
      .catch(() => []);

    if (!connectedChannels.length) {
      const allChannels = await app.db.select().from(schema.channels);
      if (allChannels.length > 0) {
        await app.db
          .update(schema.channels)
          .set({ status: "connected" })
          .where(eq(schema.channels.status, "disconnected"));
      }
    }

    let pendingSchedules = await app.db
      .select()
      .from(schema.schedules)
      .where(and(eq(schema.schedules.status, "pending"), isNull(schema.schedules.youtube_video_id)));

    if (pendingSchedules.length === 0) {
      await maybeCreateTomorrowSchedule(app).catch((error) => {
        app.logger.warn({ err: error }, "Auto planner generation skipped");
      });
      pendingSchedules = await app.db
        .select()
        .from(schema.schedules)
        .where(and(eq(schema.schedules.status, "pending"), isNull(schema.schedules.youtube_video_id)));
    }

    if (pendingSchedules.length === 0) {
      return reply.status(400).send({ error: "No pending schedules available" });
    }

    const result = await enqueueDueSchedules(app);
    return {
      success: true,
      message: "Upload scheduler tick executed",
      total_pending: pendingSchedules.length,
      queued_now: result.queued,
      queue_mode: getQueueMode(),
      simulation_mode: app.env.simulationMode,
    };
  });

  app.fastify.post("/api/upload/stop", async () => {
    const runtime = await setAutomationRunningDb(app, false);
    return {
      success: true,
      is_running: runtime.is_running,
      stopped_at: runtime.stopped_at,
    };
  });

  app.fastify.get(
    "/api/upload/jobs/:scheduleId",
    async (request: FastifyRequest<{ Params: { scheduleId: string } }>, reply: FastifyReply) => {
      const { scheduleId } = request.params;
      const job = await app.db.query.upload_jobs.findFirst({
        where: eq(schema.upload_jobs.schedule_id, scheduleId),
      });
      if (!job) {
        return reply.status(404).send({ error: "Upload job not found for schedule" });
      }
      return { job };
    },
  );
}
