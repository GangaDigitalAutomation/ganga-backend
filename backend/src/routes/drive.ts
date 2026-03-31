import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { google } from "googleapis";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../core/createApp.js";
import * as schema from "../db/schema/schema.js";
import { decryptToken, encryptToken } from "../services/tokenCrypto.js";

type DriveFolderVideosBody = {
  folderLink?: string;
  driveApiKey?: string;
};

type FolderConnectBody = {
  folderId?: string;
  folderName?: string;
  folderLink?: string;
};

function extractDriveFolderId(link: string) {
  const value = String(link || "").trim();
  if (!value) return "";
  const fromPath =
    value.match(/\/drive\/folders\/([a-zA-Z0-9_-]+)/)?.[1] ||
    value.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  if (fromPath) return fromPath;
  try {
    const url = new URL(value);
    return url.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function normalizeDriveRedirectUri() {
  const explicit = String(process.env.DRIVE_GOOGLE_REDIRECT_URI || "").trim();
  if (explicit) return explicit;
  const fallback = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (fallback.includes("/api/auth/google/callback")) {
    return fallback.replace("/api/auth/google/callback", "/api/drive/auth/callback");
  }
  return fallback;
}

function getDriveOAuthClient() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = normalizeDriveRedirectUri();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / DRIVE_GOOGLE_REDIRECT_URI");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getRequestUserId(request: FastifyRequest) {
  return String((request as any)?.user?.sub || "anonymous");
}

type GoogleDriveFile = {
  id?: string;
  name?: string;
  size?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

type GoogleDriveListResponse = {
  files?: GoogleDriveFile[];
  nextPageToken?: string;
  error?: { message?: string };
};

async function listFolderVideosByApiKey(folderId: string, driveApiKey: string, pageToken = "") {
  const query = new URLSearchParams({
    key: driveApiKey,
    q: `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`,
    fields: "nextPageToken,files(id,name,size,mimeType,createdTime,modifiedTime,webViewLink)",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
  });
  if (pageToken) query.set("pageToken", pageToken);

  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query.toString()}`);
  const payload = (await response.json().catch(() => ({}))) as GoogleDriveListResponse;
  return { response, payload };
}

async function getOAuthConnection(app: App, userId: string) {
  const row = await app.db.query.drive_oauth_connections.findFirst({
    where: eq(schema.drive_oauth_connections.user_id, userId),
  });
  return row || null;
}

async function getDriveAccessToken(app: App, userId: string) {
  const connection = await getOAuthConnection(app, userId);
  if (!connection) {
    throw new Error("Google Drive is not connected. Please sign in first.");
  }

  const oauth = getDriveOAuthClient();
  let decryptedAccess = "";
  let decryptedRefresh = "";
  try {
    decryptedAccess = decryptToken(connection.access_token);
    decryptedRefresh = decryptToken(connection.refresh_token);
  } catch (error) {
    throw new Error("Drive tokens are invalid. Please reconnect Google Drive.");
  }

  oauth.setCredentials({
    access_token: decryptedAccess,
    refresh_token: decryptedRefresh,
    expiry_date: connection.token_expiry ? new Date(connection.token_expiry).getTime() : undefined,
  });
  const refreshed = await oauth.getAccessToken();
  const accessToken = String(refreshed?.token || "").trim();
  if (!accessToken) {
    throw new Error("Failed to refresh Drive access token.");
  }
  if (accessToken !== decryptedAccess || oauth.credentials.expiry_date) {
    const tokenExpiry = oauth.credentials.expiry_date
      ? new Date(oauth.credentials.expiry_date).toISOString()
      : connection.token_expiry;
    await app.db
      .update(schema.drive_oauth_connections)
      .set({
        access_token: encryptToken(accessToken),
        token_expiry: tokenExpiry,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.drive_oauth_connections.user_id, userId));
  }
  return accessToken;
}

export function registerDriveRoutes(app: App) {
  app.fastify.post("/api/drive/auth/start", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const oauth = getDriveOAuthClient();
      const userId = getRequestUserId(request);
      const state = jwt.sign({ userId, ts: Date.now() }, app.env.jwtSecret, { expiresIn: "10m" });
      const authUrl = oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/drive.readonly",
          "openid",
          "email",
          "profile",
        ],
        state,
      });
      const wantsRedirect = String((request.query as any)?.redirect || "").trim() === "1";
      if (wantsRedirect) {
        return reply.redirect(authUrl);
      }
      return { success: true, auth_url: authUrl };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Drive auth init failed." });
    }
  });

  app.fastify.get(
    "/api/drive/auth/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply: FastifyReply) => {
      try {
        const code = String(request.query?.code || "").trim();
        const stateToken = String(request.query?.state || "").trim();
        if (!code || !stateToken) {
          return reply.status(400).type("text/html").send("<h3>Missing OAuth callback parameters.</h3>");
        }

        const decoded = jwt.verify(stateToken, app.env.jwtSecret) as { userId?: string };
        const userId = String(decoded?.userId || "").trim();
        if (!userId) {
          return reply.status(400).type("text/html").send("<h3>Invalid OAuth state.</h3>");
        }

        const oauth = getDriveOAuthClient();
        const tokenResponse = await oauth.getToken(code);
        oauth.setCredentials(tokenResponse.tokens);

        const oauth2 = google.oauth2({ version: "v2", auth: oauth });
        const me = await oauth2.userinfo.get();
        const email = String(me.data.email || "").trim();
        const accessToken = String(tokenResponse.tokens.access_token || "").trim();
        const refreshToken = String(tokenResponse.tokens.refresh_token || "").trim();
        if (!accessToken || !refreshToken) {
          return reply.status(400).type("text/html").send("<h3>Drive OAuth tokens missing.</h3>");
        }

        const now = new Date().toISOString();
        const tokenExpiry = tokenResponse.tokens.expiry_date
          ? new Date(tokenResponse.tokens.expiry_date).toISOString()
          : null;

        const existing = await getOAuthConnection(app, userId);
        if (existing) {
          await app.db
            .update(schema.drive_oauth_connections)
            .set({
              email,
              access_token: encryptToken(accessToken),
              refresh_token: encryptToken(refreshToken),
              token_expiry: tokenExpiry,
              updated_at: now,
            })
            .where(eq(schema.drive_oauth_connections.user_id, userId));
        } else {
          await app.db.insert(schema.drive_oauth_connections).values({
            user_id: userId,
            email,
            access_token: encryptToken(accessToken),
            refresh_token: encryptToken(refreshToken),
            token_expiry: tokenExpiry,
            created_at: now,
            updated_at: now,
          });
        }

        return reply.type("text/html").send(`
          <!doctype html>
          <html>
            <body style="font-family: Arial, sans-serif; padding: 20px;">
              <h3>Google Drive connected successfully.</h3>
              <p>You can close this window.</p>
              <script>
                if (window.opener) {
                  window.opener.postMessage({ type: 'drive-auth-success' }, '*');
                }
                window.close();
              </script>
            </body>
          </html>
        `);
      } catch (error) {
        return reply.status(400).type("text/html").send(`<h3>${error instanceof Error ? error.message : "Drive OAuth callback failed."}</h3>`);
      }
    },
  );

  app.fastify.get("/api/drive/auth/status", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getRequestUserId(request);
      const connection = await getOAuthConnection(app, userId);
      return {
        connected: Boolean(connection),
        email: connection?.email || null,
      };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Status check failed." });
    }
  });

  app.fastify.post("/api/drive/folders/list", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getRequestUserId(request);
      const accessToken = await getDriveAccessToken(app, userId);
      const query = new URLSearchParams({
        q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: "files(id,name,webViewLink),nextPageToken",
        pageSize: "200",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = (await response.json().catch(() => ({}))) as GoogleDriveListResponse;
      if (!response.ok) {
        const message = payload?.error?.message || `Drive API error (${response.status})`;
        return reply.status(400).send({ error: message });
      }
      const folders = (payload.files || []).map((file) => ({
        id: String(file.id || ""),
        name: String(file.name || "Untitled Folder"),
        link: file.webViewLink || `https://drive.google.com/drive/folders/${String(file.id || "")}`,
      }));
      return { success: true, folders };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Failed to list Drive folders." });
    }
  });

  app.fastify.post(
    "/api/drive/folders/connect",
    async (request: FastifyRequest<{ Body: FolderConnectBody }>, reply: FastifyReply) => {
      try {
        const userId = getRequestUserId(request);
        const folderId = String(request.body?.folderId || "").trim();
        const folderName = String(request.body?.folderName || "").trim();
        const folderLinkRaw = String(request.body?.folderLink || "").trim();
        const resolvedFolderId = folderId || extractDriveFolderId(folderLinkRaw);
        if (!resolvedFolderId) {
          return reply.status(400).send({ error: "Folder ID or folder link is required." });
        }
        const folderLink =
          folderLinkRaw || `https://drive.google.com/drive/folders/${resolvedFolderId}`;
        const now = new Date().toISOString();

        const existing = await app.db.query.drive_connected_folders.findFirst({
          where: and(
            eq(schema.drive_connected_folders.user_id, userId),
            eq(schema.drive_connected_folders.folder_id, resolvedFolderId),
          ),
        });
        if (existing) {
          await app.db
            .update(schema.drive_connected_folders)
            .set({
              folder_name: folderName || existing.folder_name,
              folder_link: folderLink,
              updated_at: now,
            })
            .where(eq(schema.drive_connected_folders.id, existing.id));
        } else {
          await app.db.insert(schema.drive_connected_folders).values({
            user_id: userId,
            folder_id: resolvedFolderId,
            folder_name: folderName || null,
            folder_link: folderLink,
            created_at: now,
            updated_at: now,
          });
        }
        return { success: true, folder_id: resolvedFolderId, folder_link: folderLink };
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : "Failed to connect Drive folder." });
      }
    },
  );

  app.fastify.get("/api/drive/folders/connected", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getRequestUserId(request);
      const rows = await app.db
        .select()
        .from(schema.drive_connected_folders)
        .where(eq(schema.drive_connected_folders.user_id, userId));
      const folders = rows.map((row) => ({
        id: row.folder_id,
        name: row.folder_name || "Drive Folder",
        link: row.folder_link,
      }));
      return { success: true, folders };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Failed to load connected folders." });
    }
  });

  app.fastify.post(
    "/api/drive/folder-videos",
    async (request: FastifyRequest<{ Body: DriveFolderVideosBody }>, reply: FastifyReply) => {
      const folderLink = String(request.body?.folderLink || "").trim();
      const driveApiKey = String(request.body?.driveApiKey || "").trim();
      const userId = getRequestUserId(request);
      const fallbackFolder = await app.db.query.drive_connected_folders.findFirst({
        where: eq(schema.drive_connected_folders.user_id, userId),
      });
      const effectiveFolderLink = folderLink || String(fallbackFolder?.folder_link || "").trim();
      if (!effectiveFolderLink) {
        return reply.status(400).send({ error: "Google Drive folder link is required." });
      }

      const folderId = extractDriveFolderId(effectiveFolderLink);
      if (!folderId) {
        return reply.status(400).send({ error: "Invalid Google Drive folder link." });
      }

      const collected: GoogleDriveFile[] = [];
      let pageToken = "";

      try {
        if (driveApiKey) {
          do {
            const { response, payload } = await listFolderVideosByApiKey(folderId, driveApiKey, pageToken);
            if (!response.ok) {
              const message = payload?.error?.message || "Failed to fetch Drive folder videos.";
              return reply.status(response.status).send({ error: message });
            }
            collected.push(...(Array.isArray(payload.files) ? payload.files : []));
            pageToken = String(payload.nextPageToken || "");
          } while (pageToken);
        } else {
          const accessToken = await getDriveAccessToken(app, userId);
          do {
            const query = new URLSearchParams({
              q: `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`,
              fields: "nextPageToken,files(id,name,size,mimeType,createdTime,modifiedTime,webViewLink)",
              pageSize: "1000",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
              corpora: "allDrives",
            });
            if (pageToken) query.set("pageToken", pageToken);
            const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query.toString()}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            const payload = (await response.json().catch(() => ({}))) as GoogleDriveListResponse;
            if (!response.ok) {
              const message = payload?.error?.message || `Drive API error (${response.status})`;
              return reply.status(400).send({ error: message });
            }
            collected.push(...(Array.isArray(payload.files) ? payload.files : []));
            pageToken = String(payload.nextPageToken || "");
          } while (pageToken);
        }

        const videos = collected.map((file) => ({
          id: `drive-${String(file.id || "")}`,
          drive_file_id: String(file.id || ""),
          drive_link:
            file.webViewLink || `https://drive.google.com/file/d/${String(file.id || "")}/view`,
          title: String(file.name || "Untitled Video"),
          original_file_name: String(file.name || "Untitled Video"),
          size: Number(file.size || 0),
          mime_type: String(file.mimeType || ""),
          created_at: file.createdTime || null,
          modified_at: file.modifiedTime || null,
          status: "pending",
        }));

        return {
          success: true,
          folder_id: folderId,
          folder_link: effectiveFolderLink,
          count: videos.length,
          videos,
        };
      } catch (error) {
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : "Drive folder fetch failed." });
      }
    },
  );
}
