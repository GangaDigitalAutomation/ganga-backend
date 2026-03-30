import crypto from "node:crypto";
import { google } from "googleapis";
import multipart from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../index.js";
import {
  addVideo,
  readAutomationDb,
  setAutomationRunning,
  upsertChannel,
  updateChannel,
  DATABASE_PATH,
  type ChannelRecord,
} from "../services/automationDb.js";
import {
  buildAuthUrl,
  ensureValidAccessToken,
  exchangeCode,
} from "../services/googleAutomation.js";
import { encryptToken } from "../services/tokenCrypto.js";
import { getAutomationRuntime, setAutomationRunningDb } from "../services/automationRuntime.js";

type ConnectInitBody = {
  channel_name?: string;
};

type ConnectCompleteBody = {
  state: string;
  code: string;
};

function parseTags(raw: string | string[] | undefined) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractDriveFileId(input: string) {
  const value = String(input || "");
  const idFromPath = value.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (idFromPath) return idFromPath;
  try {
    const url = new URL(value);
    const idFromQuery = url.searchParams.get("id");
    if (idFromQuery) return idFromQuery;
  } catch {
    return "";
  }
  return "";
}

function registerDualPost(app: App, route: string, handler: any, schema?: any) {
  app.fastify.post(route, schema ? { schema } : {}, handler);
  app.fastify.post(`/api${route}`, schema ? { schema } : {}, handler);
}

function registerDualGet(app: App, route: string, handler: any, schema?: any) {
  app.fastify.get(route, schema ? { schema } : {}, handler);
  app.fastify.get(`/api${route}`, schema ? { schema } : {}, handler);
}

export function registerAutomationRoutes(app: App) {
  app.fastify.register(multipart);

  registerDualPost(
    app,
    "/connect-channel",
    async (
      request: FastifyRequest<{ Body: ConnectInitBody & Partial<ConnectCompleteBody> }>,
      reply: FastifyReply
    ) => {
      const body = request.body || {};
      const hasCode = typeof body.code === "string" && typeof body.state === "string";

      if (!hasCode) {
        const state = crypto.randomUUID();
        const authUrl = buildAuthUrl(state);
        const now = new Date().toISOString();
        const newChannel: ChannelRecord = {
          id: crypto.randomUUID(),
          channel_name: body.channel_name?.trim() || "Pending Channel",
          access_token: "",
          refresh_token: "",
          expiry_date: "",
          oauth_state: state,
          created_at: now,
          updated_at: now,
        };
        await upsertChannel(newChannel);

        return {
          success: true,
          step: "authorize",
          channel_id: newChannel.id,
          state,
          auth_url: authUrl,
        };
      }

      const db = await readAutomationDb();
      const channel = db.channels.find((c) => c.oauth_state === body.state);
      if (!channel) {
        return reply.status(404).send({
          success: false,
          message: "Invalid state. Start channel connection again.",
        });
      }

      const exchanged = await exchangeCode(body.code!);
      await updateChannel(channel.id, {
        channel_name: exchanged.channelName,
        access_token: encryptToken(exchanged.accessToken),
        refresh_token: encryptToken(exchanged.refreshToken),
        expiry_date: exchanged.expiryDate,
        oauth_state: null,
      });

      return {
        success: true,
        step: "connected",
        channel_id: channel.id,
        channel_name: exchanged.channelName,
        expiry_date: exchanged.expiryDate,
      };
    },
    {
      description: "Start OAuth flow or complete OAuth callback and save channel tokens",
      tags: ["automation"],
    }
  );

  registerDualPost(
    app,
    "/upload-video",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const db = await readAutomationDb();
      const channel = db.channels.find((c) => Boolean(c.refresh_token));
      if (!channel) {
        return reply.status(400).send({
          success: false,
          message: "No connected channel found. Connect channel first.",
        });
      }

      const accessToken = await ensureValidAccessToken(channel);
      const drive = google.drive({
        version: "v3",
        auth: (() => {
          const oauth2 = new google.auth.OAuth2();
          oauth2.setCredentials({ access_token: accessToken });
          return oauth2;
        })(),
      });

      let driveLink = "";
      let driveFileId = "";
      let title = "";
      let description = "";
      let tags: string[] = [];

      const isMultipart = request.headers["content-type"]?.includes("multipart/form-data");
      if (isMultipart) {
        const part = await (request as any).file();
        if (!part) {
          return reply.status(400).send({ success: false, message: "Missing file in multipart request" });
        }

        title = String(part.fields?.title?.value || part.filename || "Untitled").trim();
        description = String(part.fields?.description?.value || "").trim();
        tags = parseTags(part.fields?.tags?.value as string);

        const created = await drive.files.create({
          requestBody: {
            name: part.filename,
            mimeType: part.mimetype,
          },
          media: {
            mimeType: part.mimetype,
            body: part.file,
          },
          fields: "id,webViewLink,webContentLink",
        });

        const fileId = created.data.id;
        if (!fileId) {
          throw new Error("Google Drive upload failed, no file id returned");
        }
        driveFileId = fileId;
        driveLink = created.data.webViewLink || created.data.webContentLink || `https://drive.google.com/file/d/${fileId}/view`;
      } else {
        const body = (request.body || {}) as {
          drive_link?: string;
          title?: string;
          description?: string;
          tags?: string[] | string;
        };
        driveLink = String(body.drive_link || "").trim();
        driveFileId = extractDriveFileId(driveLink);
        title = String(body.title || "").trim();
        description = String(body.description || "").trim();
        tags = parseTags(body.tags);
      }

      if (!driveLink || !driveFileId || !title) {
        return reply.status(400).send({
          success: false,
          message: "valid drive_link or uploaded file and title are required",
        });
      }

      const now = new Date().toISOString();
      const video = {
        id: crypto.randomUUID(),
        drive_file_id: driveFileId,
        drive_link: driveLink,
        title,
        description,
        tags,
        status: "pending" as const,
        upload_count: 0,
        created_at: now,
        updated_at: now,
      };
      await addVideo(video);

      return {
        success: true,
        video,
      };
    },
    {
      description: "Upload file to Google Drive or save a drive link with metadata",
      tags: ["automation"],
    }
  );

  app.fastify.get(
    "/videos",
    {
      schema: {
        description: "List automation queue videos",
        tags: ["automation"],
      },
    },
    async () => {
      const db = await readAutomationDb();
      return {
        videos: db.videos.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      };
    }
  );

  registerDualPost(
    app,
    "/start-automation",
    async () => {
      await setAutomationRunning(true);
      const runtime = await setAutomationRunningDb(app, true);
      return {
        success: true,
        is_running: true,
        started_at: runtime.started_at,
        database_path: DATABASE_PATH,
      };
    },
    {
      description: "Enable automated hourly uploader",
      tags: ["automation"],
    }
  );

  registerDualPost(
    app,
    "/stop-automation",
    async () => {
      await setAutomationRunning(false);
      const runtime = await setAutomationRunningDb(app, false);
      return {
        success: true,
        is_running: false,
        stopped_at: runtime.stopped_at,
      };
    },
    {
      description: "Disable automated hourly uploader",
      tags: ["automation"],
    }
  );

  registerDualGet(
    app,
    "/automation-status",
    async () => {
      const db = await readAutomationDb();
      const runtime = await getAutomationRuntime(app);
      const pendingCount = db.videos.filter((v) => v.status === "pending").length;
      const uploadedCount = db.videos.filter((v) => v.status === "uploaded").length;
      return {
        is_running: runtime.is_running,
        last_changed_at: runtime.updated_at,
        started_at: runtime.started_at,
        stopped_at: runtime.stopped_at,
        pending_videos: pendingCount,
        uploaded_videos: uploadedCount,
      };
    },
    {
      description: "Queue and automation runtime status",
      tags: ["automation"],
    }
  );

  registerDualGet(
    app,
    "/oauth/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply: FastifyReply) => {
      const { code, state } = request.query || {};
      if (!code || !state) {
        return reply.status(400).send("Missing code/state query params");
      }
      const internalResponse = await app.fastify.inject({
        method: "POST",
        url: "/connect-channel",
        payload: { code, state },
      });

      if (internalResponse.statusCode >= 400) {
        return reply.status(400).type("text/html").send("<h3>Connection failed. Check backend logs.</h3>");
      }

      return reply
        .type("text/html")
        .send("<h3>YouTube channel connected successfully. You can close this window.</h3>");
    }
  );
}

export { extractDriveFileId };
