import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../core/createApp.js";
import { getQueueMode } from "../queue/uploadQueue.js";
import { isAutomationRunning } from "../services/automationRuntime.js";

export function registerHealthRoutes(app: App) {
  app.fastify.get("/", async () => {
    return { status: "ok", message: "Server is live" };
  });

  app.fastify.get("/health", async () => {
    return { status: "ok", service: "api", timestamp: new Date().toISOString() };
  });

  app.fastify.get("/health/deps", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await app.db.execute("select 1");
      return {
        ok: true,
        dependencies: {
          database: app.env.databaseUrl ? "postgres" : "pglite",
          queue: getQueueMode(),
        },
      };
    } catch (error) {
      return reply.status(500).send({
        ok: false,
        error: error instanceof Error ? error.message : "Dependency health failed",
      });
    }
  });

  app.fastify.get("/health/full", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await app.db.execute("select 1");
      const automationRunning = await isAutomationRunning(app);
      return {
        ok: true,
        checks: {
          api: "ok",
          database: "ok",
          queue_mode: getQueueMode(),
          automation_running: automationRunning,
          simulation_mode: app.env.simulationMode,
        },
      };
    } catch (error) {
      return reply.status(500).send({
        ok: false,
        checks: {
          api: "ok",
          database: "failed",
          queue_mode: getQueueMode(),
        },
        error: error instanceof Error ? error.message : "Health full failed",
      });
    }
  });
}
