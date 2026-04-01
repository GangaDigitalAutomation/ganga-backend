import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { google } from "googleapis";
import type { App } from "../core/createApp.js";
import * as schema from "../db/schema/schema.js";
import { signSession } from "../auth/session.js";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeFrontendUrl(raw: string | undefined) {
  const value = String(raw || "").trim();
  if (!value) return "http://localhost:3000";
  const absolute = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return absolute.replace(/\/+$/, "");
}

function normalizeBackendUrl(raw: string | undefined) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const absolute = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return absolute.replace(/\/+$/, "");
}

function resolveYoutubeRedirectUri() {
  const explicit = String(process.env.YOUTUBE_REDIRECT_URI || "").trim();
  if (explicit) return explicit;
  const fallback = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (fallback && fallback.includes("/api/auth/google/callback")) {
    return fallback.replace("/api/auth/google/callback", "/auth/google/callback");
  }
  return "https://ganga-backend-production.up.railway.app/auth/google/callback";
}

async function upsertUser(app: App, email: string, name?: string | null) {
  const normalized = normalizeEmail(email);
  const existing = await app.db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${normalized}`)
    .limit(1);

  if (existing.length > 0) {
    const current = existing[0];
    await app.db
      .update(schema.users)
      .set({
        name: name ?? current.name,
        is_allowed: current.is_allowed,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.users.id, current.id));
    return { ...current, name: name ?? current.name };
  }

  const isAllowed = app.env.allowedEmails.length === 0 || app.env.allowedEmails.includes(normalized);
  const [created] = await app.db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email: normalized,
      name: name || null,
      is_allowed: isAllowed,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .returning();
  return created;
}

export function registerAuthRoutes(app: App) {
  app.fastify.post(
    "/api/auth/dev-login",
    async (request: FastifyRequest<{ Body: { email?: string; name?: string } }>, reply: FastifyReply) => {
      const email = normalizeEmail(request.body?.email || "local-admin@example.com");
      const name = request.body?.name || "Local Admin";
      const user = await upsertUser(app, email, name);
      if (!user.is_allowed) {
        return reply.status(403).send({ error: "Email is not allowlisted" });
      }
      const token = signSession(app, { sub: user.id, email: user.email, is_allowed: true });
      return { success: true, token, user };
    },
  );

  app.fastify.get("/api/auth/google/start", async (_request, reply) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      return reply.status(400).send({ error: "Google OAuth is not configured" });
    }
    const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const url = oauth.generateAuthUrl({
      scope: ["openid", "email", "profile"],
      prompt: "consent",
      access_type: "offline",
    });
    return reply.redirect(url);
  });

  // Channel OAuth start (YouTube connect)
  app.fastify.get(
    "/auth/google",
    async (request: FastifyRequest<{ Querystring: { channelId?: string } }>, reply: FastifyReply) => {
      const channelId = String(request.query?.channelId || "").trim();
      if (!channelId) {
        return reply.status(400).send("Missing channelId");
      }

      const redirectUri = resolveYoutubeRedirectUri();

      const channel = await app.db.query.channels.findFirst({
        where: eq(schema.channels.id, channelId),
      });
      if (!channel) {
        return reply.status(404).send("Channel not found");
      }

      app.logger.info({ channelId, redirectUri }, "Starting channel OAuth");
      await app.db.insert(schema.upload_logs).values({
        channel_id: channelId,
        level: "info",
        message: "OAuth start initiated",
        created_at: new Date().toISOString(),
      });

      const oauth = new google.auth.OAuth2(channel.client_id, channel.client_secret, redirectUri);
      const url = oauth.generateAuthUrl({
        scope: [
          "https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/drive.readonly",
        ],
        prompt: "consent",
        access_type: "offline",
        state: channelId,
      });
      app.logger.info({ channelId, redirectUri, url }, "Generated channel OAuth URL");
      return reply.redirect(url);
    },
  );

  // Channel OAuth callback (YouTube connect)
  app.fastify.get(
    "/auth/google/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply: FastifyReply) => {
      const code = String(request.query?.code || "").trim();
      const channelId = String(request.query?.state || "").trim();
      app.logger.info({ query: request.query }, "Channel OAuth callback query");
      app.logger.info({ codePresent: Boolean(code), channelId }, "Channel OAuth callback");

      if (!code || !channelId) {
        return reply.status(400).type("text/html").send("<h3>Missing OAuth callback parameters.</h3>");
      }

      const redirectUri = resolveYoutubeRedirectUri();
      app.logger.info({ channelId, redirectUri }, "Channel OAuth callback redirect URI");

      const channel = await app.db.query.channels.findFirst({
        where: eq(schema.channels.id, channelId),
      });
      if (!channel) {
        return reply.status(404).type("text/html").send("<h3>Channel not found.</h3>");
      }

      try {
        const oauth = new google.auth.OAuth2(channel.client_id, channel.client_secret, redirectUri);
        app.logger.info({ channelId, redirectUri }, "Exchanging code for tokens");
        const { tokens } = await oauth.getToken(code);
        app.logger.info({ channelId, tokenKeys: Object.keys(tokens || {}) }, "OAuth tokens received");
        oauth.setCredentials(tokens);

        if (!tokens?.access_token) {
          throw new Error("Missing access_token in OAuth response");
        }

        const token_expiry = tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString();

        const youtube = google.youtube({ version: "v3", auth: oauth });
        const channelResponse = await youtube.channels.list({ part: ["snippet"], mine: true });
        app.logger.info({ channelId, response: channelResponse.data }, "YouTube channel response");
        const youtube_channel_id = channelResponse.data.items?.[0]?.id;
        if (!youtube_channel_id) {
          throw new Error("No YouTube channel found for this account");
        }
        const youtube_channel_url = `https://youtube.com/channel/${youtube_channel_id}`;

        await app.db
          .update(schema.channels)
          .set({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || channel.refresh_token,
            token_expiry,
            youtube_channel_id,
            youtube_channel_url,
            status: "connected",
          })
          .where(eq(schema.channels.id, channelId));

        await app.db.insert(schema.upload_logs).values({
          channel_id: channelId,
          level: "info",
          message: `Channel connected: ${channel.name}`,
          created_at: new Date().toISOString(),
        });

        app.logger.info({ channelId, youtube_channel_id }, "Channel OAuth stored tokens");

        const frontendUrl = normalizeFrontendUrl(process.env.FRONTEND_URL);
        return reply.redirect(
          `${frontendUrl}/dashboard?channel_connected=1&channel_id=${encodeURIComponent(channelId)}&status=connected`,
        );
      } catch (error) {
        const errPayload =
          (error as any)?.response?.data ||
          (error as any)?.data ||
          (error as any)?.message ||
          error;
        app.logger.error({ err: errPayload, channelId }, "Channel OAuth callback failed");
        await app.db.insert(schema.upload_logs).values({
          channel_id: channelId,
          level: "error",
          message: `OAuth callback failed: ${String(errPayload)}`,
          created_at: new Date().toISOString(),
        });
        return reply.status(400).type("text/html").send(`<h3>OAuth callback failed: ${String(errPayload)}</h3>`);
      }
    },
  );

  app.fastify.get(
    "/api/auth/google/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string } }>, reply: FastifyReply) => {
      const code = request.query?.code;
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI;

      if (!code || !clientId || !clientSecret || !redirectUri) {
        return reply.status(400).send({ error: "Missing OAuth callback parameters" });
      }

      const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const tokenResponse = await oauth.getToken(code);
      oauth.setCredentials(tokenResponse.tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: oauth });
      const me = await oauth2.userinfo.get();
      const email = normalizeEmail(me.data.email || "");
      if (!email) {
        return reply.status(400).send({ error: "Email not available from Google profile" });
      }
      const user = await upsertUser(app, email, me.data.name || null);
      if (!user.is_allowed) {
        return reply.status(403).send({ error: "Email is not allowlisted" });
      }
      const token = signSession(app, { sub: user.id, email: user.email, is_allowed: true });
      const frontendUrl = normalizeFrontendUrl(process.env.FRONTEND_URL);
      return reply.redirect(`${frontendUrl}/dashboard?token=${encodeURIComponent(token)}`);
    },
  );
}
