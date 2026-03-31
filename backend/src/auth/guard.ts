import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../core/createApp.js";
import { verifySession } from "./session.js";

const OPEN_PREFIXES = ["/health", "/api/auth", "/api/events", "/api/drive/auth/callback"];

export function registerAuthGuard(app: App) {
  app.fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!app.env.authRequired) return;
    if (OPEN_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;

    const auth = request.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const token = auth.replace("Bearer ", "").trim();
    try {
      const payload = verifySession(app, token);
      if (!payload?.is_allowed) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      (request as any).user = payload;
    } catch {
      return reply.status(401).send({ error: "Invalid token" });
    }
  });
}
