import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../core/createApp.js";

type DriveFolderVideosBody = {
  folderLink?: string;
  driveApiKey?: string;
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

type DriveFile = {
  id?: string;
  name?: string;
  size?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
};

export function registerDriveRoutes(app: App) {
  app.fastify.post(
    "/api/drive/folder-videos",
    async (request: FastifyRequest<{ Body: DriveFolderVideosBody }>, reply: FastifyReply) => {
      const folderLink = String(request.body?.folderLink || "").trim();
      const driveApiKey = String(request.body?.driveApiKey || "").trim();
      if (!folderLink) {
        return reply.status(400).send({ error: "Google Drive folder link is required." });
      }
      if (!driveApiKey) {
        return reply.status(400).send({ error: "Drive API key is required." });
      }

      const folderId = extractDriveFolderId(folderLink);
      if (!folderId) {
        return reply.status(400).send({ error: "Invalid Google Drive folder link." });
      }

      const collected: DriveFile[] = [];
      let pageToken = "";

      try {
        do {
          const query = new URLSearchParams({
            key: driveApiKey,
            q: `'${folderId}' in parents and trashed=false and mimeType contains 'video/'`,
            fields:
              "nextPageToken,files(id,name,size,mimeType,createdTime,modifiedTime,webViewLink)",
            pageSize: "1000",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            corpora: "allDrives",
          });
          if (pageToken) query.set("pageToken", pageToken);

          const response = await fetch(`https://www.googleapis.com/drive/v3/files?${query.toString()}`);
          const payload = (await response.json().catch(() => ({}))) as {
            files?: DriveFile[];
            nextPageToken?: string;
            error?: { message?: string };
          };

          if (!response.ok) {
            const message = payload?.error?.message || "Failed to fetch Drive folder videos.";
            return reply.status(response.status).send({ error: message });
          }

          const files = Array.isArray(payload.files) ? payload.files : [];
          collected.push(...files);
          pageToken = String(payload.nextPageToken || "");
        } while (pageToken);

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
          folder_link: folderLink,
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

