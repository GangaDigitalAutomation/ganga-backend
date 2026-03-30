import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { desc } from "drizzle-orm";
import * as schema from "../db/schema/schema.js";
import type { App } from "../core/createApp.js";

type EventClient = {
  id: string;
  reply: FastifyReply;
};

type UploadEventType = "schedule.queued" | "upload.started" | "upload.completed" | "upload.failed" | "publish.completed";

const clients = new Map<string, EventClient>();

export function registerSseClient(reply: FastifyReply) {
  const id = randomUUID();
  clients.set(id, { id, reply });
  reply.raw.on("close", () => {
    clients.delete(id);
  });
  return id;
}

function writeSseEvent(reply: FastifyReply, event: { id: string; type: string; payload: string }) {
  reply.raw.write(`id: ${event.id}\n`);
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${event.payload}\n\n`);
}

export async function replayRecentEvents(app: App, reply: FastifyReply, lastEventId?: string) {
  const recent = await app.db
    .select()
    .from(schema.upload_events)
    .orderBy(desc(schema.upload_events.created_at))
    .limit(500);
  const ordered = recent.reverse();
  const startIndex = lastEventId ? ordered.findIndex((event) => event.id === lastEventId) + 1 : 0;
  const replay = startIndex > 0 ? ordered.slice(startIndex) : ordered;
  for (const event of replay) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(event.payload || "{}");
    } catch {
      payload = {};
    }
    const body = JSON.stringify({
      type: event.event_type,
      schedule_id: event.schedule_id || null,
      upload_job_id: event.upload_job_id || null,
      payload,
      timestamp: event.created_at,
    });
    writeSseEvent(reply, { id: event.id, type: event.event_type, payload: body });
  }
}

export async function publishUploadEvent(
  app: App,
  params: {
    eventType: UploadEventType;
    scheduleId?: string | null;
    uploadJobId?: string | null;
    payload?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const payload = params.payload || {};
  const [inserted] = await app.db
    .insert(schema.upload_events)
    .values({
      id: randomUUID(),
      schedule_id: params.scheduleId || null,
      upload_job_id: params.uploadJobId || null,
      event_type: params.eventType,
      payload: JSON.stringify(payload),
      created_at: now,
    })
    .returning();
  const eventId = inserted?.id || randomUUID();

  const body = JSON.stringify({
    type: params.eventType,
    schedule_id: params.scheduleId || null,
    upload_job_id: params.uploadJobId || null,
    payload,
    timestamp: now,
  });

  for (const client of clients.values()) {
    try {
      writeSseEvent(client.reply, { id: eventId, type: params.eventType, payload: body });
    } catch {
      clients.delete(client.id);
    }
  }
}
