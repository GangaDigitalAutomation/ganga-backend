import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../index.js";
import {
  generateAutoSchedule,
  getContentSettings,
  saveContentSettings,
  saveManualSlots,
} from "../services/autoPlannerEngine.js";

type ContentSettingsBody = {
  titles?: string[];
  description?: string;
  tags?: string[];
  videos_per_day?: number;
  start_time?: string;
};

type GenerateBody = {
  target_date?: string;
  videos_per_day?: number;
  start_time?: string;
};

type SaveSlotsBody = {
  slots: Array<{
    slot_number: number;
    date: string;
    time: string;
    video_id: string;
    title: string;
  }>;
};

export function registerAutoPlannerRoutes(app: App) {
  app.fastify.get("/api/content-settings", async () => {
    const settings = await getContentSettings();
    return { settings };
  });

  app.fastify.put(
    "/api/content-settings",
    async (request: FastifyRequest<{ Body: ContentSettingsBody }>, reply: FastifyReply) => {
      try {
        const settings = await saveContentSettings(request.body || {});
        return { success: true, settings };
      } catch (error) {
        app.logger.error({ err: error }, "Failed to save content settings");
        return reply.status(400).send({
          success: false,
          error: error instanceof Error ? error.message : "Failed to save content settings",
        });
      }
    },
  );

  app.fastify.post(
    "/api/auto-schedule",
    async (request: FastifyRequest<{ Body: GenerateBody }>, reply: FastifyReply) => {
      try {
        const plan = await generateAutoSchedule(app, request.body || {});
        return { success: true, plan };
      } catch (error) {
        app.logger.error({ err: error }, "Auto schedule generation failed");
        return reply.status(400).send({
          success: false,
          error: error instanceof Error ? error.message : "Auto schedule generation failed",
        });
      }
    },
  );

  app.fastify.post(
    "/api/auto-schedule/save",
    async (request: FastifyRequest<{ Body: SaveSlotsBody }>, reply: FastifyReply) => {
      try {
        const slots = Array.isArray(request.body?.slots) ? request.body.slots : [];
        const result = await saveManualSlots(app, slots);
        return { success: true, ...result };
      } catch (error) {
        app.logger.error({ err: error }, "Saving manual slots failed");
        return reply.status(400).send({
          success: false,
          error: error instanceof Error ? error.message : "Saving manual slots failed",
        });
      }
    },
  );
}
