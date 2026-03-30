import type { App } from "../core/createApp.js";
import { registerSseClient, replayRecentEvents } from "../services/eventBus.js";

export function registerEventRoutes(app: App) {
  app.fastify.get("/api/events", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();
    const lastEventIdHeader = request.headers["last-event-id"];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    await replayRecentEvents(app, reply, lastEventId);
    registerSseClient(reply);
    reply.raw.write(`event: connected\n`);
    reply.raw.write(`data: ${JSON.stringify({ ok: true, timestamp: new Date().toISOString(), replayed: true })}\n\n`);
    const heartbeat = setInterval(() => {
      reply.raw.write(`event: ping\n`);
      reply.raw.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, 20_000);
    reply.raw.on("close", () => clearInterval(heartbeat));
  });
}
