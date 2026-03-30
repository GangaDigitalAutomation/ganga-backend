/* eslint-disable no-console */
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");
const {
  normalizeSlotPlan: normalizeHumanSlotPlan,
  prepareHumanizedSlotPlans,
  isSlotDueForUpload,
  parseDateTime,
} = require("../utils/scheduler_engine");

const DAILY_UPLOAD_LIMIT = 5;
const YOUTUBE_DAILY_QUOTA = 10000;
const YOUTUBE_UPLOAD_COST = 1600;
const MAX_UPLOADS_PER_RUN = 1;

function getDbPath() {
  const configured = process.env.AUTOMATION_DB_PATH;
  if (configured) return path.resolve(process.cwd(), configured);
  return path.resolve(process.cwd(), "database", "automation-db.json");
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseDriveFileId(link) {
  const value = String(link || "");
  const idFromPath = value.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (idFromPath) return idFromPath;
  try {
    const url = new URL(value);
    return url.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function getEncryptionKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || "";
  if (!secret || secret.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be set and at least 32 characters long");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function decryptToken(payload) {
  if (typeof payload === "string" && payload.split(":").length !== 3) {
    return payload;
  }
  const [ivHex, contentHex, tagHex] = String(payload || "").split(":");
  if (!ivHex || !contentHex || !tagHex) {
    throw new Error("Invalid encrypted token payload");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(contentHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

async function readDb() {
  const dbPath = getDbPath();
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  if (!fs.existsSync(dbPath)) {
    const bootstrap = {
      channels: [],
      videos: [],
      automation: { is_running: false, updated_at: null },
    };
    await fsp.writeFile(dbPath, JSON.stringify(bootstrap, null, 2), "utf8");
  }
  const raw = await fsp.readFile(dbPath, "utf8");
  return JSON.parse(raw || "{}");
}

async function writeDb(db) {
  const dbPath = getDbPath();
  await fsp.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function normalizeExternalTokenChannels(payload) {
  const list = Array.isArray(payload?.channels) ? payload.channels : [];
  return list
    .map((item) => ({
      id: String(item?.channel_id || item?.id || "").trim(),
      channel_name: String(item?.channel_name || item?.name || item?.channel_id || item?.id || "").trim(),
      access_token: String(item?.access_token || "").trim(),
      refresh_token: String(item?.refresh_token || "").trim(),
      expiry_date: String(item?.expiry_date || "").trim(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => row.id && row.refresh_token);
}

async function fetchSecureChannelsFromBackend() {
  const tokenApiUrl = String(process.env.TOKEN_API_URL || "").trim();
  const tokensJson = String(process.env.TOKENS_JSON || "").trim();

  if (tokenApiUrl) {
    const response = await fetch(tokenApiUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(`TOKEN_API_URL request failed with status ${response.status}`);
    }
    const payload = await response.json();
    return normalizeExternalTokenChannels(payload);
  }

  if (tokensJson) {
    let payload;
    try {
      payload = JSON.parse(tokensJson);
    } catch (error) {
      throw new Error("TOKENS_JSON is invalid JSON.");
    }
    return normalizeExternalTokenChannels(payload);
  }

  return [];
}

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI (or YOUTUBE_* equivalents)");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function ensureValidAccessToken(channel, db) {
  const expiry = new Date(channel.expiry_date).getTime();
  const now = Date.now();
  if (Number.isFinite(expiry) && now < expiry - 60_000) {
    return decryptToken(channel.access_token);
  }

  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    refresh_token: decryptToken(channel.refresh_token),
  });
  const refreshed = await oauth2.refreshAccessToken();
  const accessToken = refreshed.credentials.access_token;
  if (!accessToken) {
    throw new Error("Failed to refresh Google access token");
  }
  const nextExpiry = refreshed.credentials.expiry_date
    ? new Date(refreshed.credentials.expiry_date).toISOString()
    : new Date(Date.now() + 3500 * 1000).toISOString();

  const idx = db.channels.findIndex((c) => c.id === channel.id);
  if (idx >= 0) {
    db.channels[idx].access_token = encryptToken(accessToken);
    db.channels[idx].expiry_date = nextExpiry;
    db.channels[idx].updated_at = new Date().toISOString();
  }
  await writeDb(db);
  return accessToken;
}

function shuffleArray(input) {
  const arr = Array.isArray(input) ? input.slice() : [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeTags(rawTags) {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) {
    return rawTags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  return String(rawTags)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function downloadFromDrive(accessToken, driveFileId, driveLink) {
  const fileId = String(driveFileId || "").trim() || parseDriveFileId(driveLink);
  if (!fileId) {
    throw new Error(`Unable to parse Google Drive file id from: ${driveLink}`);
  }
  const tmpPath = path.join(os.tmpdir(), `gda-${Date.now()}-${fileId}.mp4`);

  try {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    console.log("Scopes:", String(oauth2.credentials?.scope || ""));
    const drive = google.drive({ version: "v3", auth: oauth2 });
    const writer = fs.createWriteStream(tmpPath);

    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );
    await new Promise((resolve, reject) => {
      res.data
        .on("end", resolve)
        .on("error", reject)
        .pipe(writer)
        .on("error", reject)
        .on("finish", resolve);
    });
  } catch (error) {
    const errText = JSON.stringify(error?.response?.data || error?.message || error);
    const isScopeError =
      errText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
      errText.includes("insufficientPermissions");
    if (!isScopeError) {
      throw error;
    }

    throw new Error(
      "ERROR: Missing Drive Scope. Reconnect required."
    );
  }

  return { tmpPath, fileId };
}

async function uploadToYoutube(accessToken, video, localPath) {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  console.log("Scopes:", String(oauth2.credentials?.scope || ""));
  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: video.title,
        description: video.description || "",
        tags: normalizeTags(video.tags),
      },
      status: {
        privacyStatus: "private",
        publishAt: video.publishAt || undefined,
      },
    },
    media: {
      body: fs.createReadStream(localPath),
    },
  });

  return response.data.id || null;
}

function normalizeSlotPlan(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots
    .map((slot, index) => {
      const date = String(slot?.date || "").trim();
      const time = String(slot?.time || "").trim();
      const title = String(slot?.title || "").trim();
      const videoId = String(slot?.videoId || "").trim();
      const match = time.match(/^(\d{1,2}):(\d{2})$/);
      if (!match || !date) return null;
      const hh = Number(match[1]);
      const mm = Number(match[2]);
      if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        return null;
      }
      return {
        slotNumber: Number(slot?.slot_number || (index + 1)),
        date,
        time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
        title,
        videoId,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.slotNumber - b.slotNumber);
}

function buildDistributedSlots(count) {
  const safeCount = Math.max(1, Math.min(5, Number(count || 1)));
  const presets = {
    1: [5],
    2: [1, 5],
    3: [1, 4, 5],
    4: [1, 2, 4, 5],
    5: [1, 2, 3, 4, 5],
  };
  const fixedTimes = {
    1: { hour: 4, minute: 0 },
    2: { hour: 7, minute: 0 },
    3: { hour: 13, minute: 0 },
    4: { hour: 17, minute: 0 },
    5: { hour: 22, minute: 0 },
  };
  const slotNumbers = presets[safeCount] || presets[1];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  return slotNumbers.map((slotNumber) => {
    const fixed = fixedTimes[slotNumber] || fixedTimes[5];
    return {
      slotNumber,
      date,
      time: `${String(fixed.hour).padStart(2, "0")}:${String(fixed.minute).padStart(2, "0")}`,
      title: "",
      videoId: "",
    };
  });
}

function buildPublishAt(slot) {
  const dateParts = String(slot?.date || "").split("-").map((part) => Number(part));
  const timeParts = String(slot?.time || "").split(":").map((part) => Number(part));
  if (dateParts.length === 3 && timeParts.length === 2) {
    const dt = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1], 0, 0);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString();
    }
  }
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(4, 0, 0, 0);
  return fallback.toISOString();
}

function getLocalDateKey(value = new Date()) {
  const date = new Date(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getRandomIntInclusive(min, max) {
  const safeMin = Math.ceil(Number(min || 0));
  const safeMax = Math.floor(Number(max || 0));
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildDailyRandomOffsets({ count, min = 1, max = 3, lastPattern = "" }) {
  const safeCount = Math.max(0, Number(count || 0));
  if (!safeCount) return { offsets: [], pattern: "" };

  let best = Array.from({ length: safeCount }, () => getRandomIntInclusive(min, max));
  let pattern = best.join(",");
  if (!lastPattern || pattern !== String(lastPattern || "")) {
    return { offsets: best, pattern };
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const next = Array.from({ length: safeCount }, () => getRandomIntInclusive(min, max));
    const nextPattern = next.join(",");
    if (nextPattern !== String(lastPattern || "")) {
      return { offsets: next, pattern: nextPattern };
    }
    best = next;
    pattern = nextPattern;
  }

  const rotated = best.slice(1).concat(best[0]);
  return { offsets: rotated, pattern: rotated.join(",") };
}

function uniqueOffsetPublishAt(basePublishAt, offsetMinutes, takenIsoSet) {
  const dt = new Date(basePublishAt);
  if (Number.isNaN(dt.getTime())) return basePublishAt;
  dt.setMinutes(dt.getMinutes() + Number(offsetMinutes || 0));
  while (takenIsoSet.has(dt.toISOString())) {
    dt.setMinutes(dt.getMinutes() + 1);
  }
  const iso = dt.toISOString();
  takenIsoSet.add(iso);
  return iso;
}

function getErrorCode(error) {
  return String(error?.code || error?.cause?.code || "").trim().toUpperCase();
}

function getHttpStatus(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function isTransientUploadError(error) {
  const code = getErrorCode(error);
  const status = getHttpStatus(error);
  const message = String(error?.message || "").toLowerCase();

  if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"].includes(code)) {
    return true;
  }
  if (status === 429 || status >= 500) {
    return true;
  }
  return (
    message.includes("socket hang up")
    || message.includes("network error")
    || message.includes("timed out")
    || message.includes("econnreset")
  );
}

function getRetryDelayMs(attemptIndex) {
  const base = 1500;
  const maxDelay = 15000;
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(maxDelay, base * (2 ** attemptIndex) + jitter);
}

async function retryAsyncOperation(action, { attempts = 3 } = {}) {
  let attempt = 0;
  let lastError = null;
  while (attempt < attempts) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1) break;
      const delayMs = getRetryDelayMs(attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
  throw lastError;
}

async function uploadToYoutubeWithRetry({ accessToken, video, localPath, maxRetries = 3 }) {
  let attempt = 0;
  while (true) {
    try {
      return await uploadToYoutube(accessToken, video, localPath);
    } catch (error) {
      const transient = isTransientUploadError(error);
      if (!transient || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = getRetryDelayMs(attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

async function run() {
  const db = await readDb();
  if (!db.automation?.is_running) {
    console.log("Automation is stopped. Exiting.");
    return;
  }

  const localChannels = Array.isArray(db.channels) ? db.channels : [];
  const desiredChannelIds = new Set(
    localChannels
      .map((item) => String(item.channel_id || item.id || "").trim())
      .filter(Boolean)
  );

  let secureChannels = [];
  try {
    secureChannels = await fetchSecureChannelsFromBackend();
  } catch (error) {
    console.warn("Secure token fetch failed, falling back to local token records:", error.message || error);
  }

  const filteredSecure = secureChannels.filter((item) => (
    desiredChannelIds.size === 0 || desiredChannelIds.has(item.id)
  ));
  const fallbackLocal = localChannels.filter((item) => Boolean(item.refresh_token));
  const executionChannels = filteredSecure.length ? filteredSecure : fallbackLocal;

  if (!executionChannels.length) {
    console.log("No connected channel found. Exiting.");
    return;
  }

  const settings = db.settings || {};
  const autoScheduleEnabled = String(settings.auto_schedule_enabled ?? process.env.AUTO_SCHEDULE_ENABLED ?? "true").toLowerCase() !== "false";
  if (!autoScheduleEnabled) {
    console.log("Auto schedule is disabled. Exiting.");
    return;
  }
  const selectedChannelIds = Array.isArray(settings.selected_channel_ids)
    ? settings.selected_channel_ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const schedulerConfig = settings.scheduler_config && typeof settings.scheduler_config === "object"
    ? settings.scheduler_config
    : {};
  const minGapHours = Math.max(1, Number(schedulerConfig.min_gap_hours || process.env.MIN_GAP_HOURS || 2));
  const maxGapHours = Math.max(minGapHours, Number(schedulerConfig.max_gap_hours || process.env.MAX_GAP_HOURS || 6));
  const variationMinutes = Math.max(0, Number(schedulerConfig.time_variation_minutes || process.env.TIME_VARIATION_MINUTES || 30));
  const enableDailyShift = String(schedulerConfig.enable_daily_shift ?? process.env.ENABLE_DAILY_SHIFT ?? "true").toLowerCase() !== "false";
  const configuredPerDay = Math.max(1, Math.min(5, Number(settings.videos_per_day || DAILY_UPLOAD_LIMIT)));
  const channelSlotPlans = settings.channel_slot_plans && typeof settings.channel_slot_plans === "object"
    ? settings.channel_slot_plans
    : {};
  const filteredChannels = selectedChannelIds.length
    ? executionChannels.filter((channel) => selectedChannelIds.includes(String(channel.id || "").trim()))
    : executionChannels;
  if (!filteredChannels.length) {
    console.log("No channels selected for automation today. Exiting.");
    return;
  }

  const pending = (db.videos || []).filter((v) => v.status === "pending");

  if (!pending.length) {
    console.log("No pending videos in queue.");
    return;
  }

  const generatedPlans = {};
  filteredChannels.forEach((channel) => {
    const channelId = String(channel.id || "").trim();
    const base = normalizeHumanSlotPlan(channelSlotPlans[channelId] || settings.slots).slice(0, configuredPerDay);
    if (base.length) {
      generatedPlans[channelId] = base;
      return;
    }
    const fallback = buildDistributedSlots(configuredPerDay).map((slot) => ({
      slot_number: Number(slot.slotNumber),
      date: String(slot.date || ""),
      time: String(slot.time || ""),
      videoId: String(slot.videoId || ""),
      title: String(slot.title || ""),
      status: "scheduled",
      upload_date: "",
      upload_time: "",
      manual_upload_time: false,
    }));
    generatedPlans[channelId] = fallback;
  });

  const humanizedPlans = prepareHumanizedSlotPlans({
    channelSlotPlans: generatedPlans,
    channelIds: filteredChannels.map((channel) => String(channel.id || "").trim()),
    now: new Date(),
    minGapMinutes: Math.round(minGapHours * 60),
    maxGapMinutes: Math.round(maxGapHours * 60),
    minLeadMinutes: 45,
    variationMinutes,
    enableDailyShift,
  });

  db.settings = db.settings || {};
  db.settings.channel_slot_plans = {
    ...(db.settings.channel_slot_plans || {}),
    ...humanizedPlans,
  };

  const channelStates = db.automation?.channel_states && typeof db.automation.channel_states === "object"
    ? db.automation.channel_states
    : {};
  const uploadedVideos = db.automation?.uploaded_videos && typeof db.automation.uploaded_videos === "object"
    ? db.automation.uploaded_videos
    : {};

  const titlePool = Array.isArray(settings.title_pool) ? settings.title_pool.map((t) => String(t || "").trim()).filter(Boolean) : [];
  const settingsDescription = String(settings.description || "").trim();
  const settingsTags = normalizeTags(settings.tags || []);

  const pendingById = new Map(pending.map((v) => [String(v.id || "").trim(), v]));
  const usedVideoIds = new Set();
  let runUploadedCount = 0;

  for (const channel of filteredChannels) {
    if (runUploadedCount >= MAX_UPLOADS_PER_RUN) break;
    const channelId = String(channel.id || "").trim();
    if (!channelId) continue;

    const dayKey = getLocalDateKey();
    const today = todayUtcDate();
    const uploadedTodayForChannel = (db.videos || []).filter(
      (v) =>
        v.status === "uploaded"
        && String(v.uploaded_channel_id || "").trim() === channelId
        && String(v.uploaded_at || "").startsWith(today)
    ).length;
    const remainingQuota = Math.max(0, YOUTUBE_DAILY_QUOTA - (uploadedTodayForChannel * YOUTUBE_UPLOAD_COST));
    if (remainingQuota < YOUTUBE_UPLOAD_COST) {
      console.log(`[QUOTA_STOP] ${channelId} has low quota. Skipping.`);
      continue;
    }

    const slotPlan = (Array.isArray(humanizedPlans[channelId]) ? humanizedPlans[channelId] : [])
      .slice(0, configuredPerDay)
      .filter((slot) => isSlotDueForUpload(slot, new Date()))
      .sort((a, b) => {
        const left = parseDateTime(a.upload_date, a.upload_time)?.getTime() || Number.MAX_SAFE_INTEGER;
        const right = parseDateTime(b.upload_date, b.upload_time)?.getTime() || Number.MAX_SAFE_INTEGER;
        return left - right;
      });

    if (!slotPlan.length) {
      console.log(`[CHANNEL_SKIP] ${channelId} has no due upload slots right now.`);
      continue;
    }

    const channelState = channelStates[channelId] && typeof channelStates[channelId] === "object"
      ? channelStates[channelId]
      : {};
    const uploadedHistory = new Set(
      Array.isArray(uploadedVideos[channelId]) ? uploadedVideos[channelId].map((id) => String(id || "").trim()).filter(Boolean) : []
    );

    const candidateIds = pending
      .map((video) => String(video.id || "").trim())
      .filter(Boolean)
      .filter((id) => !uploadedHistory.has(id));

    let videoOrder = Array.isArray(channelState.video_order)
      ? channelState.video_order.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const shouldRefreshVideoOrder = (
      !videoOrder.length
      || channelState.video_order_day !== dayKey
      || videoOrder.some((id) => !candidateIds.includes(id))
      || candidateIds.some((id) => !videoOrder.includes(id))
    );
    if (shouldRefreshVideoOrder) {
      let nextOrder = shuffleArray(candidateIds);
      if (arraysEqual(nextOrder, videoOrder) && nextOrder.length > 1) {
        nextOrder = nextOrder.slice(1).concat(nextOrder[0]);
      }
      videoOrder = nextOrder;
    }
    let videoPointer = Math.max(0, Number(channelState.video_pointer || 0));

    let titleOrder = Array.isArray(channelState.title_order)
      ? channelState.title_order.map((title) => String(title || "").trim()).filter(Boolean)
      : [];
    if (titlePool.length) {
      const shouldRefreshTitleOrder = (
        !titleOrder.length
        || channelState.title_order_day !== dayKey
        || titleOrder.some((title) => !titlePool.includes(title))
        || titlePool.some((title) => !titleOrder.includes(title))
      );
      if (shouldRefreshTitleOrder) {
        let nextTitles = shuffleArray(titlePool);
        if (arraysEqual(nextTitles, titleOrder) && nextTitles.length > 1) {
          nextTitles = nextTitles.slice(1).concat(nextTitles[0]);
        }
        titleOrder = nextTitles;
      }
    } else {
      titleOrder = [];
    }
    let titlePointer = Math.max(0, Number(channelState.title_pointer || 0));
    let lastTitle = String(channelState.last_title || "").trim();

    const offsetPattern = String(channelState.last_offset_pattern || "");

    let accessToken;
    try {
      accessToken = await ensureValidAccessToken(channel, db);
      console.log("Using Access Token:", accessToken);
    } catch (error) {
      console.error(`Token refresh failed for ${channelId}:`, error.message || error);
      continue;
    }

    const takeNextVideoCandidate = (preferredId, triedIds) => {
      const trimmedPreferred = String(preferredId || "").trim();
      if (
        trimmedPreferred
        && !triedIds.has(trimmedPreferred)
        && !usedVideoIds.has(trimmedPreferred)
        && !uploadedHistory.has(trimmedPreferred)
        && pendingById.has(trimmedPreferred)
      ) {
        return pendingById.get(trimmedPreferred);
      }

      if (!videoOrder.length) return null;
      for (let i = 0; i < videoOrder.length; i += 1) {
        const idx = (videoPointer + i) % videoOrder.length;
        const candidateId = String(videoOrder[idx] || "").trim();
        if (
          !candidateId
          || triedIds.has(candidateId)
          || usedVideoIds.has(candidateId)
          || uploadedHistory.has(candidateId)
          || !pendingById.has(candidateId)
        ) {
          continue;
        }
        videoPointer = (idx + 1) % videoOrder.length;
        return pendingById.get(candidateId);
      }
      return null;
    };

    const nextTitle = (fallbackTitle, slotTitle = "") => {
      const hardSlotTitle = String(slotTitle || "").trim();
      if (hardSlotTitle && hardSlotTitle !== lastTitle) {
        lastTitle = hardSlotTitle;
        return hardSlotTitle;
      }

      if (titleOrder.length) {
        for (let i = 0; i < titleOrder.length; i += 1) {
          const idx = (titlePointer + i) % titleOrder.length;
          const candidate = String(titleOrder[idx] || "").trim();
          if (!candidate) continue;
          titlePointer = (idx + 1) % titleOrder.length;
          if (candidate !== lastTitle || titleOrder.length === 1) {
            lastTitle = candidate;
            return candidate;
          }
        }
      }

      const fallback = String(fallbackTitle || "").trim();
      if (fallback && fallback !== lastTitle) {
        lastTitle = fallback;
        return fallback;
      }
      return fallback || `GDA Upload ${Date.now()}`;
    };

    for (let slotIndex = 0; slotIndex < slotPlan.length; slotIndex += 1) {
      if (runUploadedCount >= MAX_UPLOADS_PER_RUN) break;
      const slot = slotPlan[slotIndex];
      const preferredId = String(slot.videoId || slot.video_id || "").trim();
      const triedVideoIds = new Set();
      const publishAt = buildPublishAt(slot);
      let slotUploaded = false;

      while (!slotUploaded && runUploadedCount < MAX_UPLOADS_PER_RUN) {
        const video = takeNextVideoCandidate(preferredId, triedVideoIds);
        if (!video) break;
        const videoId = String(video.id || "").trim();
        triedVideoIds.add(videoId);
        let tmpFile = null;

        try {
          const uploadTitle = nextTitle(
            String(video.assigned_title || video.title || "").trim() || `GDA Upload ${Date.now()}`,
            String(slot.title || "").trim()
          );

          console.log(`[UPLOAD_SLOT] ${channelId} slot ${slot.slot_number} @ ${slot.upload_date || "?"} ${slot.upload_time || "?"}`);
          console.log("Downloading from Drive...");
          const downloaded = await retryAsyncOperation(
            async () => downloadFromDrive(accessToken, video.drive_file_id, video.drive_link),
            { attempts: 3 }
          );
          tmpFile = downloaded.tmpPath;

          const safeVideo = {
            ...video,
            title: uploadTitle,
            description: String(video.description || settingsDescription || "Uploaded via Ganga Digital Automation").trim(),
            tags: normalizeTags(video.tags || settingsTags),
            publishAt,
          };
          console.log("Uploading to YouTube...");
          const youtubeVideoId = await uploadToYoutubeWithRetry({
            accessToken,
            video: safeVideo,
            localPath: tmpFile,
            maxRetries: 3,
          });

          const idx = db.videos.findIndex((v) => v.id === video.id);
          if (idx >= 0) {
            db.videos[idx].assigned_title = uploadTitle;
            db.videos[idx].title = uploadTitle;
            db.videos[idx].status = "uploaded";
            db.videos[idx].upload_count = Number(db.videos[idx].upload_count || 0) + 1;
            db.videos[idx].uploaded_at = new Date().toISOString();
            db.videos[idx].updated_at = new Date().toISOString();
            db.videos[idx].youtube_video_id = youtubeVideoId;
            db.videos[idx].scheduled_publish_at = publishAt;
            const uploadAt = parseDateTime(slot.upload_date, slot.upload_time);
            db.videos[idx].scheduled_upload_at = uploadAt ? uploadAt.toISOString() : null;
            db.videos[idx].uploaded_channel_id = channelId;
          }

          uploadedHistory.add(videoId);
          usedVideoIds.add(videoId);
          runUploadedCount += 1;
          slotUploaded = true;
          console.log(`Uploaded: ${uploadTitle}`);
          await writeDb(db);
        } catch (error) {
          const errorText = String(error?.message || error || "");
          if (errorText.includes("insufficientPermissions") || errorText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
            console.log("ERROR: Missing Drive Scope. Reconnect required.");
          }
          console.error(`Failed: ${(video.assigned_title || video.title || video.id)}`, error.message || error);
          const idx = db.videos.findIndex((v) => v.id === video.id);
          if (idx >= 0) {
            db.videos[idx].upload_count = Number(db.videos[idx].upload_count || 0) + 1;
            db.videos[idx].updated_at = new Date().toISOString();
            db.videos[idx].last_error = String(error?.message || error || "Unknown upload error");
          }
          await writeDb(db);
          console.log(`Fail-safe: trying next video for channel ${channelId}, slot ${slot.slot_number}`);
        } finally {
          if (tmpFile && fs.existsSync(tmpFile)) {
            await fsp.unlink(tmpFile).catch(() => {});
          }
        }
      }
    }

    uploadedVideos[channelId] = Array.from(uploadedHistory).slice(-5000);
    channelStates[channelId] = {
      ...channelState,
      video_order: videoOrder,
      video_pointer: videoPointer,
      video_order_day: dayKey,
      title_order: titleOrder,
      title_pointer: titlePointer,
      title_order_day: dayKey,
      last_title: lastTitle,
      last_offset_pattern: offsetPattern,
      last_offset_day: dayKey,
      updated_at: new Date().toISOString(),
    };
  }

  db.automation = {
    ...(db.automation || {}),
    uploaded_videos: uploadedVideos,
    channel_states: channelStates,
    rotation_index: 0,
    title_rotation_index: 0,
    updated_at: new Date().toISOString(),
  };
  await writeDb(db);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 0;
});
