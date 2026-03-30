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
      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
      return reply.redirect(`${frontendUrl}/dashboard?token=${encodeURIComponent(token)}`);
    },
  );
}
