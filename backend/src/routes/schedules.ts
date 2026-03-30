import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import type { App } from "../index.js";

type ScheduleInput = {
  channel_id: string;
  video_id: string;
  scheduled_at: string;
  publish_at?: string | null;
  slot_no?: number | null;
  upload_at?: string | null;
};

export function registerScheduleRoutes(app: App) {
  app.fastify.get(
    "/api/schedules",
    async (request: FastifyRequest<{ Querystring: { channel_id?: string } }>) => {
      const { channel_id } = request.query;
      const baseQuery = app.db
        .select({
          id: schema.schedules.id,
          channel_id: schema.schedules.channel_id,
          video_id: schema.schedules.video_id,
          scheduled_at: schema.schedules.scheduled_at,
          publish_at: schema.schedules.publish_at,
          slot_no: schema.schedules.slot_no,
          upload_at: schema.schedules.upload_at,
          status: schema.schedules.status,
          youtube_video_id: schema.schedules.youtube_video_id,
          error_message: schema.schedules.error_message,
          retry_count: schema.schedules.retry_count,
          created_at: schema.schedules.created_at,
          channel_name: schema.channels.name,
          video_name: schema.videos.name,
          video_file_path: schema.videos.file_path,
        })
        .from(schema.schedules)
        .leftJoin(schema.channels, eq(schema.schedules.channel_id, schema.channels.id))
        .leftJoin(schema.videos, eq(schema.schedules.video_id, schema.videos.id));

      const rows = channel_id
        ? await baseQuery.where(eq(schema.schedules.channel_id, channel_id))
        : await baseQuery;

      return {
        schedules: rows.map((row) => ({
          id: row.id,
          channel_id: row.channel_id,
          video_id: row.video_id,
          scheduled_at: row.scheduled_at,
          publish_at: row.publish_at,
          slot_no: row.slot_no,
          upload_at: row.upload_at,
          status: row.status,
          youtube_video_id: row.youtube_video_id,
          error_message: row.error_message,
          retry_count: row.retry_count,
          created_at: row.created_at,
          channel: row.channel_name ? { name: row.channel_name } : null,
          video: row.video_name ? { name: row.video_name, file_path: row.video_file_path } : null,
        })),
      };
    },
  );

  app.fastify.post(
    "/api/schedules/bulk",
    async (request: FastifyRequest<{ Body: { schedules: ScheduleInput[] } }>, reply: FastifyReply) => {
      const scheduleList = Array.isArray(request.body?.schedules) ? request.body.schedules : [];
      if (scheduleList.length === 0) {
        return reply.status(400).send({ error: "No schedules provided" });
      }
      const now = new Date().toISOString();
      const inserted = await app.db
        .insert(schema.schedules)
        .values(
          scheduleList.map((entry) => ({
            channel_id: entry.channel_id,
            video_id: entry.video_id,
            scheduled_at: entry.scheduled_at,
            publish_at: entry.publish_at ?? entry.scheduled_at,
            slot_no: entry.slot_no ?? null,
            upload_at: entry.upload_at ?? null,
            status: "pending",
            retry_count: 0,
            created_at: now,
          })),
        )
        .returning();
      reply.status(201);
      return { schedules: inserted, count: inserted.length };
    },
  );

  app.fastify.post(
    "/api/schedules",
    async (request: FastifyRequest<{ Body: ScheduleInput }>, reply: FastifyReply) => {
      const { channel_id, video_id, scheduled_at, upload_at } = request.body;
      const [inserted] = await app.db
        .insert(schema.schedules)
        .values({
          channel_id,
          video_id,
          scheduled_at,
          publish_at: request.body.publish_at ?? scheduled_at,
          slot_no: request.body.slot_no ?? null,
          upload_at: upload_at ?? null,
          status: "pending",
          retry_count: 0,
          created_at: new Date().toISOString(),
        })
        .returning();
      reply.status(201);
      return inserted;
    },
  );

  app.fastify.delete(
    "/api/schedules/clear",
    async (request: FastifyRequest<{ Querystring: { channel_id: string } }>) => {
      await app.db.delete(schema.schedules).where(eq(schema.schedules.channel_id, request.query.channel_id));
      return { success: true };
    },
  );

  app.fastify.delete(
    "/api/schedules/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const schedule = await app.db.query.schedules.findFirst({
        where: eq(schema.schedules.id, request.params.id),
      });
      if (!schedule) {
        return reply.status(404).send({ error: "Schedule not found" });
      }
      await app.db.delete(schema.schedules).where(eq(schema.schedules.id, request.params.id));
      return { success: true };
    },
  );
}
