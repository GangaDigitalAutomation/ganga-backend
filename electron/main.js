const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { google } = require('googleapis');
const { loadState, updateState } = require('./lib/storage');
const { runOAuthFlow, getChannelInfo, buildOAuthClientFromChannel } = require('./lib/youtube');
const { encryptObject, decryptObject } = require('./lib/secureStore');
const { generateSchedule, autoAssignVideos } = require('./lib/scheduler');
const { createUploader, checkInternet } = require('./lib/uploader');

let mainWindow;
let authWindow;
let uploadInProgress = false;
let updateInitialized = false;
let automationSchedulerTimer = null;
let autoUpdater = null;
const DEFAULT_AUTOMATION_SLOTS = ['00:10', '06:30', '10:00', '16:00', '22:00'];
const YOUTUBE_DAILY_QUOTA_UNITS = 10000;
const YOUTUBE_UPLOAD_COST_UNITS = 1600;
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'www.googleapis.com',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
]);

const updaterStatus = {
  stage: 'idle',
  message: 'Update not checked yet.',
  currentVersion: app.getVersion(),
  availableVersion: null,
  updateAvailable: false,
  downloaded: false,
  lastCheckedAt: null,
  feedUrlConfigured: false,
};

function sendUpdateStatus() {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { ...updaterStatus });
  }
}

function setUpdateStatus(patch) {
  Object.assign(updaterStatus, patch || {});
  sendUpdateStatus();
}

function resolveUpdateFeedUrl() {
  const fromEnv = String(process.env.GDA_UPDATE_BASE_URL || '').trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, '');
  }

  const configPath = path.join(__dirname, '..', 'config', 'update.json');
  if (!fs.existsSync(configPath)) {
    return '';
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const fromFile = String(parsed.baseUrl || '').trim();
    return fromFile.replace(/\/+$/, '');
  } catch (error) {
    sendLog(`Update config parse warning: ${error.message || error}`);
    return '';
  }
}

function initializeAutoUpdater() {
  if (updateInitialized) return;
  updateInitialized = true;

  if (process.platform !== 'win32') {
    setUpdateStatus({
      stage: 'not-supported',
      message: 'Auto-update is currently enabled for Windows builds.',
      feedUrlConfigured: false,
    });
    return;
  }

  if (!app.isPackaged) {
    setUpdateStatus({
      stage: 'unavailable',
      message: 'Update service unavailable for this build.',
      feedUrlConfigured: false,
    });
    return;
  }

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (error) {
    setUpdateStatus({
      stage: 'error',
      message: `Updater init failed: ${error?.message || error}`,
      feedUrlConfigured: false,
    });
    return;
  }

  const feedUrl = resolveUpdateFeedUrl();
  if (!feedUrl) {
    setUpdateStatus({
      stage: 'not-configured',
      message: 'Update server URL is missing. Set GDA_UPDATE_BASE_URL or config/update.json.',
      feedUrlConfigured: false,
    });
    return;
  }

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: feedUrl,
  });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => {
    setUpdateStatus({
      stage: 'checking',
      message: 'Checking for updates...',
      lastCheckedAt: new Date().toISOString(),
      feedUrlConfigured: true,
    });
  });

  autoUpdater.on('update-available', (info) => {
    const nextVersion = String(info?.version || '').trim() || 'unknown';
    setUpdateStatus({
      stage: 'downloading',
      message: `New version ${nextVersion} found. Downloading...`,
      updateAvailable: true,
      downloaded: false,
      availableVersion: nextVersion,
      feedUrlConfigured: true,
    });
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateStatus({
      stage: 'up-to-date',
      message: 'You already have the latest version installed.',
      updateAvailable: false,
      downloaded: false,
      availableVersion: null,
      feedUrlConfigured: true,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent || 0))));
    setUpdateStatus({
      stage: 'downloading',
      message: `Downloading update... ${percent}%`,
      feedUrlConfigured: true,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const nextVersion = String(info?.version || '').trim() || updaterStatus.availableVersion || 'new';
    setUpdateStatus({
      stage: 'downloaded',
      message: `Version ${nextVersion} is ready. Click install to restart and update.`,
      downloaded: true,
      updateAvailable: true,
      availableVersion: nextVersion,
      feedUrlConfigured: true,
    });
  });

  autoUpdater.on('error', (error) => {
    setUpdateStatus({
      stage: 'error',
      message: `Update failed: ${error?.message || 'Unknown error'}`,
      feedUrlConfigured: true,
    });
  });

  setUpdateStatus({
    stage: 'ready',
    message: 'Updater ready. Use Check for Updates.',
    feedUrlConfigured: true,
  });
}

function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((tag) => String(tag).trim()).filter(Boolean);
  return String(raw).split(',').map((tag) => tag.trim()).filter(Boolean);
}

function extractDriveFileId(link) {
  const value = String(link || '').trim();
  if (!value) return '';
  const fromPath = value.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (fromPath) return fromPath;
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get('id');
    if (fromQuery) return fromQuery;
  } catch (error) {
    return '';
  }
  return '';
}

function extractDriveFolderId(link) {
  const value = String(link || '').trim();
  if (!value) return '';
  const fromPath = value.match(/\/drive\/folders\/([a-zA-Z0-9_-]+)/)?.[1]
    || value.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  if (fromPath) return fromPath;
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get('id');
    if (fromQuery) return fromQuery;
  } catch (error) {
    return '';
  }
  return '';
}

function isChannelSelected(channel) {
  return channel?.is_selected !== false && channel?.selected !== false;
}

function safeDecryptString(value) {
  if (!value) return '';
  try {
    const decrypted = decryptObject(value);
    return typeof decrypted === 'string' ? decrypted : '';
  } catch (error) {
    return String(value || '');
  }
}

function getLocalDateKey(value = new Date()) {
  const date = new Date(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeTimeSlot(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getAutomationSlots(state) {
  const fromState = Array.isArray(state?.settings?.automationSlots) ? state.settings.automationSlots : [];
  const normalized = [...new Set(fromState.map(normalizeTimeSlot).filter(Boolean))];
  if (normalized.length) return normalized.sort();
  return DEFAULT_AUTOMATION_SLOTS.slice();
}

function hasSlotRunToday(state, dateKey, slot) {
  const map = state?.settings?.slotRunsByDate || {};
  const todaySlots = Array.isArray(map?.[dateKey]) ? map[dateKey] : [];
  return todaySlots.includes(slot);
}

function markSlotRunToday(slot) {
  const dateKey = getLocalDateKey();
  return updateState((state) => {
    state.settings = state.settings || {};
    const runs = state.settings.slotRunsByDate || {};
    const today = Array.isArray(runs[dateKey]) ? runs[dateKey] : [];
    if (!today.includes(slot)) {
      today.push(slot);
      runs[dateKey] = today;
    }
    const keepKeys = Object.keys(runs).sort().slice(-3);
    const compact = {};
    keepKeys.forEach((key) => { compact[key] = runs[key]; });
    state.settings.slotRunsByDate = compact;
    return state;
  });
}

function toTitleCase(input) {
  return String(input || '').replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
}

function buildVideoTitle(filePath) {
  const fileName = path.basename(filePath || '');
  const normalized = fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return `Video Upload ${Date.now()}`;
  }
  return toTitleCase(normalized);
}

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/mov',
  'video/mkv',
  'video/avi',
  'video/x-msvideo',
]);

const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi']);

function isAllowedDriveVideoFile(file) {
  const mimeType = String(file?.mimeType || '').toLowerCase();
  if (ALLOWED_VIDEO_MIME_TYPES.has(mimeType)) {
    return true;
  }

  const fileName = String(file?.name || '').toLowerCase();
  return fileName.endsWith('.mp4')
    || fileName.endsWith('.mov')
    || fileName.endsWith('.mkv')
    || fileName.endsWith('.avi');
}

function isAllowedVideoFilePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ALLOWED_VIDEO_EXTENSIONS.has(ext);
}

function getVideoDisplayName(video) {
  return String(video?.assigned_title || video?.title || video?.original_file_name || 'Untitled Video');
}

function getDriveApiKeyFromState(state) {
  const fromSettings = safeDecryptString(state?.settings?.driveApiKey).trim();
  if (fromSettings) return fromSettings;

  const fromEnv = String(process.env.DRIVE_API_KEY || '').trim();
  if (fromEnv) return fromEnv;

  return '';
}

function getDriveWriteClientFromState(state) {
  const channels = state?.channels || [];
  const selectedConnected = channels.filter((channel) => isChannelSelected(channel) && channel.token_status === 'connected');
  const anyConnected = channels.filter((channel) => channel.token_status === 'connected');

  for (const channel of [...selectedConnected, ...anyConnected]) {
    try {
      const oauth2Client = buildOAuthClientFromChannel(channel);
      const creds = oauth2Client.credentials || {};
      if (creds.access_token || creds.refresh_token) {
        return oauth2Client;
      }
    } catch (error) {
      // Ignore bad token records and continue.
    }
  }

  return null;
}

function getCurrentFolderRef(state, payload) {
  const fromPayload = String(payload?.folderLink || '').trim();
  const rememberedLink = typeof state?.videoFolder === 'string'
    ? state.videoFolder
    : state?.videoFolder?.link;
  const folderLink = fromPayload || rememberedLink || '';
  const folderId = extractDriveFolderId(folderLink);
  return { folderLink, folderId };
}

function mapDriveFolderImportError(error) {
  const raw = String(error?.message || error || '').trim();
  const message = raw.toLowerCase();

  if (!raw) return 'Drive API error';
  if (message.includes('invalid folder link')) return 'Invalid folder link';
  if (message.includes('no video files found')) return 'No video files found';
  if (
    message.includes('insufficient')
    || message.includes('permission')
    || message.includes('forbidden')
    || message.includes('not found')
    || message.includes('file not found')
  ) {
    return 'Folder is not accessible. Make sure the folder is shared as "Anyone with the link".';
  }
  if (message.includes('invalid credentials') || message.includes('unauthorized') || message.includes('scope')) {
    return 'Drive OAuth scope is missing. Reconnect channel and allow Drive readonly access.';
  }

  return `Drive API error: ${raw}`;
}

function mapDriveWriteError(error) {
  const raw = String(error?.message || error || '').trim();
  const message = raw.toLowerCase();
  if (!raw) return 'Drive write failed';
  if (message.includes('insufficient') || message.includes('permission') || message.includes('forbidden')) {
    return 'Drive write permission denied. Reconnect channel token with Drive access.';
  }
  if (message.includes('login') || message.includes('unauthorized') || message.includes('invalid_grant')) {
    return 'Drive write auth expired. Reconnect channel token.';
  }
  if (message.includes('not found')) {
    return 'Drive file/folder not found.';
  }
  return `Drive write error: ${raw}`;
}

function shuffleArray(input) {
  const arr = Array.isArray(input) ? input.slice() : [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseTitleLines(rawTitles) {
  if (Array.isArray(rawTitles)) {
    return rawTitles.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(rawTitles || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getBackendHostCandidates(state) {
  const candidates = [];
  const fromEnv = [
    process.env.GDA_BACKEND_API_URL,
    process.env.EXPO_PUBLIC_API_BASE_URL,
    process.env.BACKEND_API_URL,
  ];
  fromEnv.forEach((value) => {
    const raw = String(value || '').trim();
    if (raw) candidates.push(raw);
  });

  const fromState = String(state?.settings?.backendApiBaseUrl || '').trim();
  if (fromState) candidates.push(fromState);

  return candidates
    .map((entry) => {
      try {
        return new URL(entry).hostname.toLowerCase();
      } catch (error) {
        return '';
      }
    })
    .filter(Boolean);
}

function isAllowedExternalUrl(rawUrl, state) {
  const value = String(rawUrl || '').trim();
  if (!value) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const backendHosts = new Set(getBackendHostCandidates(state));
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';

  if (protocol === 'https:') {
    return ALLOWED_EXTERNAL_HOSTS.has(host) || backendHosts.has(host);
  }

  if (protocol === 'http:' && isLocalhost) {
    return true;
  }

  return false;
}

function runAutomationPreflight(state) {
  const errors = [];
  const selectedConnected = (state?.channels || []).filter((channel) => (
    isChannelSelected(channel) && channel?.token_status === 'connected'
  ));
  if (!selectedConnected.length) {
    errors.push('At least one connected and selected channel is required.');
  }

  const driveLinks = Array.isArray(state?.settings?.driveFolderLinks)
    ? state.settings.driveFolderLinks.filter((item) => Boolean(extractDriveFolderId(item)))
    : [];
  const hasDriveFolder = driveLinks.length > 0 || Boolean(extractDriveFolderId(state?.videoFolder?.link || state?.videoFolder || ''));
  if (!hasDriveFolder) {
    errors.push('Google Drive folder is not connected.');
  }

  const pendingVideos = (state?.videos || []).filter((video) => (
    video?.status === 'pending' && String(video?.drive_file_id || '').trim()
  ));
  if (!pendingVideos.length) {
    errors.push('No pending videos available for upload.');
  }

  const titlePool = parseTitleLines(state?.settings?.titlePool || []);
  if (!titlePool.length) {
    errors.push('At least one title is required.');
  }

  const slotPlan = normalizeSlotPlan(state?.settings?.slots || []);
  const completeSlots = slotPlan.filter((slot) => slot.date && slot.time && slot.videoId && slot.title);
  const requiredSlots = Math.max(1, Math.min(5, Number(state?.settings?.videosPerDay || 1)));
  if (completeSlots.length < requiredSlots) {
    errors.push(`Slots not ready. Need ${requiredSlots} fully configured slots.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      connectedChannels: selectedConnected.length,
      pendingVideos: pendingVideos.length,
      titleCount: titlePool.length,
      completeSlots: completeSlots.length,
      requiredSlots,
    },
    quota: {
      unitsPerDay: YOUTUBE_DAILY_QUOTA_UNITS,
      uploadCostPerVideo: YOUTUBE_UPLOAD_COST_UNITS,
      maxByQuotaPerChannel: Math.floor(YOUTUBE_DAILY_QUOTA_UNITS / YOUTUBE_UPLOAD_COST_UNITS),
    },
  };
}

function normalizeSlotPlan(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots.map((slot, index) => {
    const date = String(slot?.publish_date || slot?.date || '').trim();
    const time = normalizeTimeSlot(slot?.publish_time || slot?.time) || '';
    const uploadDate = String(slot?.upload_date || slot?.uploadDate || '').trim();
    const uploadTime = normalizeTimeSlot(slot?.upload_time || slot?.uploadTime) || '';
    const autoUploadEnabled = slot?.auto_upload_enabled !== undefined
      ? Boolean(slot.auto_upload_enabled)
      : !Boolean(slot?.manual_upload_time || slot?.manualUploadTime);
    return {
      slot_number: Number(slot?.slot_number || (index + 1)),
      publish_date: date,
      publish_time: time,
      date,
      time,
      videoId: String(slot?.videoId || '').trim(),
      title: String(slot?.title || '').trim(),
      upload_date: uploadDate,
      upload_time: uploadTime,
      auto_upload_enabled: autoUploadEnabled,
      manual_upload_time: !autoUploadEnabled,
      status: String(slot?.status || 'pending').trim() || 'pending',
    };
  });
}

function deriveAutomationSlotsFromPlan(rawSlots) {
  const plan = normalizeSlotPlan(rawSlots);
  const slots = [...new Set(plan.map((slot) => slot.time).filter(Boolean))];
  return slots.sort();
}

async function listDriveFolderVideoFiles({ folderId, state }) {
  const oauth2Client = getDriveWriteClientFromState(state);
  if (!oauth2Client) {
    throw new Error('Drive OAuth token missing. Reconnect a channel with drive.readonly scope.');
  }
  const accessToken = String(oauth2Client.credentials?.access_token || '');
  console.log('Using Access Token:', accessToken);
  console.log('Scopes:', String(oauth2Client.credentials?.scope || ''));
  console.log('Downloading from Drive...');
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const files = [];
  let pageToken = null;

  do {
    try {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        pageSize: 1000,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: 'nextPageToken,files(id,name,size,mimeType,webViewLink)',
        pageToken: pageToken || undefined,
      });
      const batch = response?.data?.files || [];
      files.push(...batch);
      pageToken = response?.data?.nextPageToken || null;
    } catch (error) {
      const errorText = String(error?.message || error || '');
      if (errorText.includes('insufficientPermissions') || errorText.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
        console.log('ERROR: Missing Drive Scope. Reconnect required.');
      }
      throw error;
    }
  } while (pageToken);

  return files.filter(isAllowedDriveVideoFile);
}

async function importVideosFromDriveFolder(payload, options = {}) {
  const { refresh = false } = options;
  const stateForLookup = loadState();
  const { folderLink, folderId } = getCurrentFolderRef(stateForLookup, payload);

  if (!folderId) {
    throw new Error('Invalid folder link');
  }

  const files = await listDriveFolderVideoFiles({ folderId, state: stateForLookup });
  if (!files.length) {
    throw new Error('No video files found');
  }

  const now = new Date().toISOString();
  let importedCount = 0;
  let removedCount = 0;

  const updated = updateState((state) => {
    const previousVideos = state.videos || [];
    const previousById = new Map(previousVideos
      .map((video) => [String(video.drive_file_id || '').trim(), video])
      .filter(([id]) => Boolean(id)));

    const nextVideos = [];
    files.forEach((file) => {
      const fileId = String(file.id || '').trim();
      if (!fileId) return;

      const existing = previousById.get(fileId);
      if (!existing) importedCount += 1;

      const fileName = String(file.name || '').trim() || `Drive Video ${Date.now()}`;
      const driveLink = `https://drive.google.com/uc?export=download&id=${fileId}`;
      nextVideos.push({
        id: existing?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        drive_file_id: fileId,
        drive_link: driveLink,
        title: existing?.title || '',
        assigned_title: existing?.assigned_title || existing?.title || '',
        original_file_name: fileName,
        size: Number(file.size || 0),
        description: existing?.description || String(state.settings?.globalDescription || state.settings?.defaultDescription || ''),
        tags: Array.isArray(existing?.tags) ? existing.tags : parseTags(state.settings?.globalTags || ''),
        status: existing?.status || 'pending',
        upload_count: Number(existing?.upload_count || 0),
        created_at: existing?.created_at || now,
        uploaded_at: existing?.uploaded_at || null,
        youtube_video_id: existing?.youtube_video_id || null,
        last_error: existing?.last_error || null,
      });
      previousById.delete(fileId);
    });

    removedCount = previousById.size;
    state.videos = nextVideos;

    state.videoFolder = {
      id: folderId,
      link: folderLink,
      refreshed_at: now,
      last_imported: importedCount,
      refresh,
    };
    return state;
  });

  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog(`Drive folder sync complete: ${importedCount} added, ${removedCount} removed, total ${updated.videos.length}.`);

  return {
    state: sanitizeState(updated),
    folderId,
    importedCount,
    removedCount,
    totalVideosImported: importedCount,
  };
}

function mapDriveFileToVideoRecord(file) {
  const fileId = String(file?.id || '').trim();
  const fileName = String(file?.name || '').trim() || 'Untitled Video';
  return {
    id: `drive-${fileId}`,
    drive_file_id: fileId,
    drive_link: `https://drive.google.com/file/d/${fileId}/view`,
    assigned_title: fileName,
    title: fileName,
    original_file_name: fileName,
    size: Number(file?.size || 0),
    status: 'pending',
  };
}

async function fetchDriveVideosLive(payload = {}) {
  const state = loadState();
  const { folderLink, folderId } = getCurrentFolderRef(state, payload);
  if (!folderId) {
    throw new Error('Invalid folder link');
  }

  const files = await listDriveFolderVideoFiles({ folderId, state });
  const videos = files.map(mapDriveFileToVideoRecord);

  updateState((nextState) => {
    nextState.videoFolder = {
      id: folderId,
      link: folderLink,
      refreshed_at: new Date().toISOString(),
      last_imported: videos.length,
      refresh: true,
    };
    return nextState;
  });

  return {
    folderId,
    videos,
    total: videos.length,
  };
}

function notifyBackgroundUpload() {
  if (!Notification || !Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Ganga Digital Automation',
    body: 'Uploading Videos in Background...',
    silent: false,
  });
  notification.show();
}

function sanitizeState(state) {
  const sanitized = JSON.parse(JSON.stringify(state));
  sanitized.channels = (sanitized.channels || []).map((channel) => ({
    ...channel,
    clientId: undefined,
    clientSecret: undefined,
    access_token: undefined,
    refresh_token: undefined,
    tokensEncrypted: undefined,
    redirectUri: undefined,
    oauthJsonPath: undefined,
    oauthJsonText: undefined,
  }));
  sanitized.settings = sanitized.settings || {};
  sanitized.settings.hasDriveApiKey = Boolean(state?.settings?.driveApiKey);
  sanitized.settings.hasYoutubeApiKey = Boolean(state?.settings?.youtubeApiKey);
  sanitized.settings.driveApiKey = undefined;
  sanitized.settings.youtubeApiKey = undefined;
  return sanitized;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const state = loadState();
    if (isAllowedExternalUrl(url, state)) {
      shell.openExternal(url);
    } else {
      sendLog(`Blocked external window: ${url}`);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localFilePrefix = 'file://';
    if (String(url || '').startsWith(localFilePrefix)) return;
    event.preventDefault();
    const state = loadState();
    if (isAllowedExternalUrl(url, state)) {
      shell.openExternal(url);
    } else {
      sendLog(`Blocked navigation: ${url}`);
    }
  });
  mainWindow.on('minimize', () => {
    if (uploadInProgress) notifyBackgroundUpload();
  });
}

function sendLog(message) {
  if (mainWindow) {
    mainWindow.webContents.send('log', message);
  }
}

function sendState(state) {
  if (mainWindow) {
    mainWindow.webContents.send('state', sanitizeState(state));
  }
}

function sendDriveSyncProgress(payload) {
  if (mainWindow) {
    mainWindow.webContents.send('drive-sync-progress', payload || {});
  }
}

function sendDriveUploadItem(payload) {
  if (mainWindow) {
    mainWindow.webContents.send('drive-upload-item', payload || {});
  }
}

function getAutomationUpgradeStatus() {
  const root = path.join(__dirname, '..');
  const requiredFolders = ['automation', 'database', 'config'];
  const foldersReady = requiredFolders.every((name) => fs.existsSync(path.join(root, name)));

  const apiModuleReady = fs.existsSync(path.join(root, 'backend', 'src', 'routes', 'automation.ts'));
  const workflowReady = fs.existsSync(path.join(root, '.github', 'workflows', 'upload.yml'));

  let queueCount = 0;
  let automationRunning = false;
  const dbPath = path.join(root, 'database', 'automation-db.json');
  if (fs.existsSync(dbPath)) {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      queueCount = Array.isArray(parsed.videos) ? parsed.videos.filter((v) => v.status === 'pending').length : 0;
      automationRunning = Boolean(parsed.automation?.is_running);
    } catch (error) {
      // ignore parse errors and return safe defaults
    }
  }

  const overallReady = foldersReady && apiModuleReady && workflowReady;
  return {
    overallReady,
    foldersReady,
    apiModuleReady,
    workflowReady,
    queueCount,
    automationRunning,
  };
}

function syncAutomationDatabaseFromState(state) {
  try {
    const root = path.join(__dirname, '..');
    const dbDir = path.join(root, 'database');
    const dbPath = path.join(dbDir, 'automation-db.json');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const selectedConnected = (state.channels || []).filter(
      (channel) => channel.token_status === 'connected' && channel.is_selected !== false
    );

    const payload = {
      channels: selectedConnected.map((channel) => ({
        id: channel.id,
        channel_id: channel.id,
        channel_name: channel.title || channel.label || channel.channel_name || channel.id,
        token_status: channel.token_status || 'connected',
        has_token: Boolean(channel.tokensEncrypted),
        created_at: channel.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
      videos: (state.videos || []).map((video) => ({
        id: video.id,
        drive_file_id: video.drive_file_id || '',
        drive_link: video.drive_link || `https://drive.google.com/uc?export=download&id=${video.drive_file_id}`,
        assigned_title: video.assigned_title || video.title || '',
        title: video.assigned_title || video.title || 'Untitled Video',
        size: Number(video.size || 0),
        description: video.description || state.settings?.globalDescription || state.settings?.defaultDescription || '',
        tags: Array.isArray(video.tags) ? video.tags : parseTags(video.tags || state.settings?.globalTags || ''),
        status: video.status === 'uploaded' ? 'uploaded' : 'pending',
        upload_count: Number(video.upload_count || 0),
        created_at: video.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        uploaded_at: video.uploaded_at || null,
        youtube_video_id: video.youtube_video_id || null,
      })),
      automation: {
        is_running: Boolean(state.settings?.automationRunning),
        uploaded_videos: state.settings?.uploadedVideosByChannel && typeof state.settings.uploadedVideosByChannel === 'object'
          ? state.settings.uploadedVideosByChannel
          : {},
        channel_states: state.settings?.automationIntelligence && typeof state.settings.automationIntelligence === 'object'
          ? state.settings.automationIntelligence
          : {},
        updated_at: new Date().toISOString(),
      },
      settings: {
        videos_per_day: Math.max(1, Math.min(5, Number(state.settings?.videosPerDay || 5))),
        automation_slots: getAutomationSlots(state),
        auto_schedule_enabled: state.settings?.autoScheduleEnabled !== false,
        selected_channel_ids: Array.isArray(state.settings?.selectedAutomationChannelIds)
          ? state.settings.selectedAutomationChannelIds.map((id) => String(id || '').trim()).filter(Boolean)
          : [],
        scheduler_config: {
          min_gap_hours: Math.max(1, Number(state.settings?.schedulerConfig?.minGapHours || 2)),
          max_gap_hours: Math.max(2, Number(state.settings?.schedulerConfig?.maxGapHours || 6)),
          time_variation_minutes: Math.max(0, Number(state.settings?.schedulerConfig?.timeVariationMinutes || 30)),
          enable_daily_shift: state.settings?.schedulerConfig?.enableDailyShift !== false,
        },
        slots: normalizeSlotPlan(state.settings?.slots || []),
        channel_slot_plans: Object.fromEntries(
          Object.entries(state.settings?.channelSlotPlans && typeof state.settings.channelSlotPlans === 'object'
            ? state.settings.channelSlotPlans
            : {}).map(([channelId, slots]) => [channelId, normalizeSlotPlan(slots)])
        ),
        title_pool: parseTitleLines(state.settings?.titlePool || []),
        description: String(state.settings?.globalDescription || state.settings?.defaultDescription || '').trim(),
        tags: parseTags(state.settings?.globalTags || ''),
      },
    };

    fs.writeFileSync(dbPath, JSON.stringify(payload, null, 2));
  } catch (error) {
    sendLog(`Automation DB sync warning: ${error.message || error}`);
  }
}

function normalizeChannelConnectError(error) {
  const raw = String(error?.message || '').trim();
  const message = raw.toLowerCase();

  if (message.includes('invalid_client') || message.includes('invalid client') || message.includes('client id')) {
    return 'Invalid Client ID';
  }
  if (message.includes('redirect_uri_mismatch') || message.includes('redirect uri')) {
    return 'OAuth Error: redirect_uri mismatch';
  }
  if (
    message.includes('authentication failed')
    || message.includes('authorization failed')
    || message.includes('access_denied')
    || message.includes('canceled')
  ) {
    return 'Authentication Failed';
  }
  if (message.includes('oauth')) {
    return 'OAuth Error';
  }
  if (message.includes('network') || message.includes('econn') || message.includes('enotfound') || message.includes('timeout')) {
    return 'Network Error';
  }

  return raw || 'Channel connection failed.';
}

function getTomorrowBaseDate() {
  const base = new Date();
  base.setDate(base.getDate() + 1);
  base.setHours(0, 0, 0, 0);
  return base;
}

function refreshSchedulesFromTomorrow(state) {
  const schedules = state?.schedules || {};
  const base = getTomorrowBaseDate();
  let changed = false;

  Object.keys(schedules).forEach((channelId) => {
    const items = schedules[channelId];
    if (!Array.isArray(items)) return;

    items.forEach((item) => {
      if (!Number.isInteger(item?.dayIndex)) return;
      const slotTime = String(item.time || '04:00').split(':');
      const hh = Number(slotTime[0]) || 4;
      const mm = Number(slotTime[1]) || 0;

      const nextDate = new Date(base);
      nextDate.setDate(base.getDate() + item.dayIndex);
      nextDate.setHours(hh, mm, 0, 0);

      const nextDateIso = formatDateOnly(nextDate);
      const nextTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const nextPublishAt = toIsoWithLocalOffset(nextDate);

      if (item.date !== nextDateIso || item.time !== nextTime || item.publishAt !== nextPublishAt) {
        item.date = nextDateIso;
        item.time = nextTime;
        item.publishAt = nextPublishAt;
        if (!item.status || item.status === 'failed') {
          item.status = 'pending';
        }
        changed = true;
      }
    });
  });

  return changed;
}

const uploader = createUploader({
  log: sendLog,
  progress: (payload) => {
    if (mainWindow) {
      mainWindow.webContents.send('progress', payload);
    }
  },
});

async function runUploadCycle({ keepAutomationRunning = false, origin = 'manual' } = {}) {
  if (uploadInProgress) {
    return { status: 'busy', message: 'Upload already in progress.' };
  }

  if (mainWindow && mainWindow.isMinimized()) {
    notifyBackgroundUpload();
  }

  uploadInProgress = true;
  sendLog(`Upload cycle started (${origin}).`);

  try {
    let nextState = updateState((state) => {
      state.settings = state.settings || {};
      state.settings.uploadInProgress = true;
      state.settings.videosPerDay = Math.max(1, Math.min(5, Number(state.settings.videosPerDay || 5)));
      if (keepAutomationRunning) {
        state.settings.automationRunning = true;
      }
      return state;
    });
    syncAutomationDatabaseFromState(nextState);
    sendState(nextState);

    const result = await uploader.startUploads();
    nextState = loadState();
    syncAutomationDatabaseFromState(nextState);
    sendState(nextState);
    return { status: 'ok', ...result };
  } finally {
    const finalState = updateState((state) => {
      state.settings = state.settings || {};
      state.settings.uploadInProgress = false;
      if (!keepAutomationRunning) {
        state.settings.automationRunning = false;
      }
      return state;
    });
    syncAutomationDatabaseFromState(finalState);
    sendState(finalState);
    uploadInProgress = false;
  }
}

function startAutomationScheduler() {
  if (automationSchedulerTimer) return;
  automationSchedulerTimer = setInterval(async () => {
    try {
      if (uploadInProgress) return;
      const state = loadState();
      if (!state?.settings?.automationRunning) return;
      await runUploadCycle({ keepAutomationRunning: true, origin: 'automation-loop' });
    } catch (error) {
      sendLog(`Automation scheduler warning: ${error?.message || error}`);
    }
  }, 5 * 60 * 1000);
}

app.whenReady().then(() => {
  app.setName('Ganga Digital Automation');
  createWindow();
  startAutomationScheduler();
  initializeAutoUpdater();
  setTimeout(() => {
    if (app.isPackaged && autoUpdater) {
      autoUpdater.checkForUpdates().catch((error) => {
        setUpdateStatus({
          stage: 'error',
          message: `Auto-check failed: ${error?.message || error}`,
        });
      });
    }
  }, 1500);
  console.log(`Ganga Digital Automation ${app.getVersion()} loaded`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('get-state', () => {
  const state = loadState();
  return sanitizeState(state);
});

ipcMain.handle('get-app-meta', () => ({
  name: app.getName(),
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
}));

ipcMain.handle('get-update-status', () => ({ ...updaterStatus }));

ipcMain.handle('check-for-updates', async () => {
  initializeAutoUpdater();
  if (updaterStatus.stage === 'not-configured') {
    throw new Error('Update server URL not configured.');
  }
  if (!app.isPackaged) {
    throw new Error('Update service is unavailable for this build.');
  }
  if (!autoUpdater) {
    throw new Error('Updater is not available.');
  }

  await autoUpdater.checkForUpdates();
  return { ...updaterStatus };
});

ipcMain.handle('install-downloaded-update', () => {
  if (!updaterStatus.downloaded) {
    throw new Error('No downloaded update available yet.');
  }
  if (!autoUpdater) {
    throw new Error('Updater is not available.');
  }
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
  return { accepted: true };
});

ipcMain.handle('select-folder', async () => {
  return null;
});

async function scanFolderRecursively(dir) {
  let results = [];
  try {
    const list = await fs.promises.readdir(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat && stat.isDirectory()) {
          const subRes = await scanFolderRecursively(fullPath);
          results = results.concat(subRes);
        } else {
          if (['.mp4', '.mkv', '.mov', '.avi'].includes(path.extname(fullPath).toLowerCase())) {
            results.push({
              name: file,
              path: fullPath,
              size: stat.size,
              title: buildVideoTitle(fullPath),
            });
          }
        }
      } catch (err) { }
    }
  } catch (err) { }
  return results;
}

async function collectVideoFilesFromPaths(inputPaths) {
  const queue = Array.isArray(inputPaths) ? inputPaths.filter(Boolean) : [];
  const files = [];

  while (queue.length > 0) {
    const current = String(queue.shift() || '').trim();
    if (!current) continue;

    let stat;
    try {
      stat = await fs.promises.stat(current);
    } catch (error) {
      continue;
    }

    if (stat.isDirectory()) {
      let children = [];
      try {
        children = await fs.promises.readdir(current);
      } catch (error) {
        children = [];
      }
      children.forEach((child) => queue.push(path.join(current, child)));
      continue;
    }

    if (stat.isFile() && isAllowedVideoFilePath(current)) {
      files.push({
        path: current,
        size: Number(stat.size || 0),
      });
    }
  }

  return files;
}

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.avi') return 'video/x-msvideo';
  return 'application/octet-stream';
}

ipcMain.handle('set-video-folder', async (event, folderPath) => {
  throw new Error('Local folder upload removed. Use Google Drive link in Video Library.');
});

ipcMain.handle('clear-videos', () => {
  const updated = updateState((state) => {
    state.videos = [];
    state.videoFolder = null;
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return updated;
});

ipcMain.handle('add-video-by-drive-link', (event, payload) => {
  const driveLink = String(payload?.driveLink || '').trim();
  const title = String(payload?.title || '').trim();
  const description = String(payload?.description || '').trim();
  const tags = parseTags(payload?.tags || '');

  if (!driveLink) {
    throw new Error('Google Drive link is required.');
  }
  if (!title) {
    throw new Error('Video title is required.');
  }

  const driveFileId = extractDriveFileId(driveLink);
  if (!driveFileId) {
    throw new Error('Invalid Google Drive link. Could not extract file ID.');
  }

  const now = new Date().toISOString();
  const updated = updateState((state) => {
    state.videos = state.videos || [];
    state.videos.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      drive_file_id: driveFileId,
      drive_link: driveLink,
      title,
      size: Number(payload?.size || 0),
      description,
      tags,
      status: 'pending',
      upload_count: 0,
      created_at: now,
      uploaded_at: null,
      youtube_video_id: null,
      last_error: null,
    });
    return state;
  });

  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog(`Video added from Drive: ${title} (${driveFileId})`);
  return sanitizeState(updated);
});

ipcMain.handle('import-drive-folder', async (event, payload) => {
  try {
    return await fetchDriveVideosLive(payload || {});
  } catch (error) {
    throw new Error(mapDriveFolderImportError(error));
  }
});

ipcMain.handle('refresh-drive-folder', async (event, payload) => {
  try {
    return await fetchDriveVideosLive(payload || {});
  } catch (error) {
    throw new Error(mapDriveFolderImportError(error));
  }
});

ipcMain.handle('fetch-drive-videos', async (event, payload) => {
  try {
    return await fetchDriveVideosLive(payload || {});
  } catch (error) {
    throw new Error(mapDriveFolderImportError(error));
  }
});

ipcMain.handle('set-drive-folder-link', (event, payload) => {
  const link = String(payload?.folderLink || '').trim();
  const folderId = extractDriveFolderId(link);
  if (!folderId) {
    throw new Error('Invalid folder link');
  }
  const updated = updateState((state) => {
    state.videoFolder = {
      id: folderId,
      link,
      refreshed_at: new Date().toISOString(),
    };
    return state;
  });
  return sanitizeState(updated);
});

ipcMain.handle('upload-videos-to-drive', async (event, payload) => {
  const state = loadState();
  const { folderLink, folderId } = getCurrentFolderRef(state, payload || {});
  if (!folderId) {
    throw new Error('Invalid folder link');
  }

  const oauth2Client = getDriveWriteClientFromState(state);
  if (!oauth2Client) {
    throw new Error('Drive write auth missing. Connect channel token with Drive permission.');
  }

  const rawPaths = Array.isArray(payload?.paths) ? payload.paths : [];
  const files = await collectVideoFilesFromPaths(rawPaths);
  if (!files.length) {
    throw new Error('No video files found');
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  let uploaded = 0;
  let failed = 0;
  const uploadedItems = [];
  sendDriveSyncProgress({
    phase: 'uploading',
    total: files.length,
    done: 0,
    uploaded: 0,
    failed: 0,
    message: 'Starting Drive upload...',
  });

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const fileName = path.basename(file.path);
    try {
      const response = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId],
        },
        media: {
          mimeType: getMimeTypeFromPath(file.path),
          body: fs.createReadStream(file.path),
        },
        fields: 'id,name,size,mimeType,webViewLink',
        supportsAllDrives: true,
      });
      const uploadedFileId = String(response?.data?.id || '').trim();
      const uploadedFileName = String(response?.data?.name || fileName);
      const visitLink = uploadedFileId ? `https://drive.google.com/file/d/${uploadedFileId}/view` : '';
      uploaded += 1;
      uploadedItems.push({
        fileId: uploadedFileId,
        fileName: uploadedFileName,
        visitLink,
      });
      sendDriveUploadItem({
        fileId: uploadedFileId,
        fileName: uploadedFileName,
        visitLink,
      });
      sendDriveSyncProgress({
        phase: 'uploading',
        total: files.length,
        done: i + 1,
        uploaded,
        failed,
        message: `Uploaded: ${uploadedFileName}`,
      });
    } catch (error) {
      failed += 1;
      sendDriveSyncProgress({
        phase: 'uploading',
        total: files.length,
        done: i + 1,
        uploaded,
        failed,
        message: `Failed ${fileName}: ${error?.message || error}`,
      });
    }
  }

  const syncResult = await fetchDriveVideosLive({ folderLink });
  sendDriveSyncProgress({
    phase: 'done',
    total: files.length,
    done: files.length,
    uploaded,
    failed,
    message: `Upload complete. Uploaded ${uploaded}, failed ${failed}.`,
  });
  return {
    ...syncResult,
    uploaded,
    failed,
    uploadedItems,
  };
});

ipcMain.handle('delete-drive-video', async (event, payload) => {
  const fileId = String(payload?.fileId || '').trim();
  if (!fileId) {
    throw new Error('Drive file ID is required');
  }

  const state = loadState();
  const oauth2Client = getDriveWriteClientFromState(state);
  if (!oauth2Client) {
    throw new Error('Drive write auth missing. Connect channel token with Drive permission.');
  }

  try {
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });
  } catch (error) {
    throw new Error(mapDriveWriteError(error));
  }

  const updated = updateState((nextState) => {
    nextState.videos = (nextState.videos || []).filter((video) => String(video.drive_file_id || '').trim() !== fileId);
    return nextState;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog(`Drive video deleted: ${fileId}`);

  try {
    await importVideosFromDriveFolder({}, { refresh: true });
  } catch (error) {
    // Ignore refresh failures after successful delete.
  }

  return sanitizeState(updated);
});

ipcMain.handle('delete-all-drive-videos', async (event, payload) => {
  const state = loadState();
  const oauth2Client = getDriveWriteClientFromState(state);
  if (!oauth2Client) {
    throw new Error('Drive write auth missing. Connect channel token with Drive permission.');
  }

  const liveVideos = await fetchDriveVideosLive(payload || {});
  const allIds = (liveVideos?.videos || []).map((video) => String(video.drive_file_id || '').trim()).filter(Boolean);

  if (!allIds.length) {
    const emptyState = updateState((nextState) => {
      nextState.videos = [];
      return nextState;
    });
    syncAutomationDatabaseFromState(emptyState);
    sendState(emptyState);
    return sanitizeState(emptyState);
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  for (let i = 0; i < allIds.length; i += 1) {
    const fileId = allIds[i];
    try {
      await drive.files.delete({
        fileId,
        supportsAllDrives: true,
      });
    } catch (error) {
      sendLog(`Delete warning for ${fileId}: ${error?.message || error}`);
    }
  }

  const updated = updateState((nextState) => {
    nextState.videos = [];
    return nextState;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog('All videos deleted from Drive folder and app list.');
  const latest = await fetchDriveVideosLive(payload || {});
  return latest;
});

ipcMain.handle('open-external', (event, url) => {
  const safeUrl = String(url || '').trim();
  if (!safeUrl) return { ok: false, reason: 'empty-url' };
  const state = loadState();
  if (!isAllowedExternalUrl(safeUrl, state)) {
    sendLog(`Blocked external URL: ${safeUrl}`);
    return { ok: false, reason: 'url-not-allowed' };
  }
  shell.openExternal(safeUrl);
  return { ok: true };
});

ipcMain.handle('auto-assign-video-titles', (event, rawTitles) => {
  const titles = parseTitleLines(rawTitles);

  const updated = updateState((state) => {
    const videos = state.videos || [];
    if (!videos.length || !titles.length) return state;

    const shuffledTitles = shuffleArray(titles);
    const randomizedVideos = shuffleArray(videos);
    const assignedByVideoId = new Map();

    randomizedVideos.forEach((video, index) => {
      const nextTitle = shuffledTitles[index % shuffledTitles.length];
      if (!nextTitle) return;
      assignedByVideoId.set(video.id, nextTitle);
    });

    videos.forEach((video) => {
      const nextTitle = assignedByVideoId.get(video.id) || '';
      video.assigned_title = nextTitle;
      video.title = nextTitle;
      video.description = String(state.settings?.globalDescription || state.settings?.defaultDescription || '');
      video.tags = parseTags(state.settings?.globalTags || '');
    });

    Object.values(state.schedules || {}).forEach((items) => {
      (items || []).forEach((item) => {
        if (!item?.videoPath) return;
        const mappedVideo = videos.find((video) => video.path && video.path === item.videoPath);
        const mappedTitle = mappedVideo?.assigned_title || mappedVideo?.title || '';
        if (mappedTitle) item.title = mappedTitle;
      });
    });

    state.settings = state.settings || {};
    state.settings.titlePool = titles;
    return state;
  });

  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return sanitizeState(updated);
});

ipcMain.handle('select-oauth-json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('add-channel', async (event, payload) => {
  const {
    clientId,
    clientSecret,
    apiKey,
    channelUrl,
    oauthJsonPath,
    oauthJsonText,
  } = payload;
  const now = new Date().toISOString();
  const channelId = `channel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const normalizedName = String(channelUrl || '').trim() || `Channel ${channelId.slice(-5)}`;

  const newChannel = {
    id: channelId,
    channel_name: normalizedName,
    youtube_url: String(channelUrl || '').trim(),
    label: normalizedName,
    title: normalizedName,
    thumbnail: '',
    apiKey: apiKey ? encryptObject(apiKey) : null,
    clientId: clientId ? encryptObject(clientId) : null,
    clientSecret: clientSecret ? encryptObject(clientSecret) : null,
    oauthJsonPath: oauthJsonPath || '',
    oauthJsonText: oauthJsonText || '',
    access_token: null,
    refresh_token: null,
    expiry_date: null,
    token_status: 'not_connected',
    is_selected: true,
    selected: true,
    status: 'Disconnected',
    starred: false,
    created_at: now,
    uploaded: [],
  };

  const updated = updateState((state) => {
    state.channels = state.channels || [];
    state.channels.push(newChannel);
    return state;
  });

  syncAutomationDatabaseFromState(updated);
  sendLog(`Channel added: ${newChannel.channel_name}`);
  sendState(updated);
  return sanitizeState(updated);
});

ipcMain.handle('get-channel-token', async (event, channelId) => {
  const state = loadState();
  const existingChannel = (state.channels || []).find((channel) => channel.id === channelId);
  if (!existingChannel) {
    throw new Error('Channel not found.');
  }

  const clientId = existingChannel.clientId ? decryptObject(existingChannel.clientId) : '';
  const clientSecret = existingChannel.clientSecret ? decryptObject(existingChannel.clientSecret) : '';
  if (!clientId || !clientSecret) {
    throw new Error('Client ID / Client Secret missing for this channel.');
  }

  sendLog(`Starting OAuth token flow for ${existingChannel.channel_name || existingChannel.title || channelId}`);

  const openUrl = async (url) => {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close();
    }
    authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow,
      modal: false,
      center: true,
      show: false,
      autoHideMenuBar: true,
      resizable: false,
      title: 'Google Sign In',
      webPreferences: { contextIsolation: true },
    });
    authWindow.on('closed', () => {
      authWindow = null;
    });
    authWindow.once('ready-to-show', () => {
      authWindow.center();
      authWindow.show();
      authWindow.focus();
    });
    await authWindow.loadURL(url);
    if (!authWindow.isVisible()) {
      authWindow.show();
      authWindow.focus();
    }
  };

  try {
    const { oauth2Client, tokens, redirectUri } = await runOAuthFlow({
      clientId,
      clientSecret,
      oauthJsonPath: existingChannel.oauthJsonPath || '',
      oauthJsonText: existingChannel.oauthJsonText || '',
      openUrl,
    });

    const channelInfo = await getChannelInfo(oauth2Client);
    const updated = updateState((nextState) => {
      const channel = (nextState.channels || []).find((item) => item.id === channelId);
      if (!channel) return nextState;
      channel.title = channelInfo.title || channel.title;
      channel.label = channelInfo.title || channel.label;
      channel.channel_name = channelInfo.title || channel.channel_name;
      channel.thumbnail = channelInfo.thumbnail || channel.thumbnail;
      channel.youtube_url = channel.youtube_url || `https://youtube.com/channel/${channelInfo.id}`;
      channel.channelUrl = channel.youtube_url;
      channel.redirectUri = redirectUri;
      channel.tokensEncrypted = encryptObject(tokens);
      channel.access_token = tokens.access_token ? encryptObject(tokens.access_token) : channel.access_token;
      channel.refresh_token = tokens.refresh_token ? encryptObject(tokens.refresh_token) : channel.refresh_token;
      channel.expiry_date = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
      channel.token_status = 'connected';
      channel.status = 'Connected';
      return nextState;
    });

    syncAutomationDatabaseFromState(updated);
    sendLog(`Token connected for ${channelInfo.title || existingChannel.channel_name || channelId}`);
    sendState(updated);
    return sanitizeState(updated);
  } catch (error) {
    const message = normalizeChannelConnectError(error);
    sendLog(`Token connect failed: ${message}`);
    throw new Error(message);
  } finally {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close();
    }
  }
});

ipcMain.handle('delete-channel', (event, channelId) => {
  const updated = updateState((state) => {
    state.channels = state.channels.filter((c) => c.id !== channelId);
    delete state.schedules[channelId];
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return updated;
});

ipcMain.handle('set-channel-selected', (event, payload) => {
  const { channelId, selected } = payload || {};
  const updated = updateState((state) => {
    const channel = state.channels.find((c) => c.id === channelId);
    if (channel) {
      channel.selected = Boolean(selected);
      channel.is_selected = Boolean(selected);
    }
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return sanitizeState(updated);
});

ipcMain.handle('star-channel', (event, channelId) => {
  const updated = updateState((state) => {
    const channel = state.channels.find((c) => c.id === channelId);
    if (channel) channel.starred = !channel.starred;
    return state;
  });
  sendState(updated);
  return updated;
});

ipcMain.handle('open-channel', (event, channelId) => {
  const state = loadState();
  const channel = state.channels.find((c) => c.id === channelId);
  if (channel) {
    const url = channel.youtube_url || channel.channelUrl || '';
    if (url && isAllowedExternalUrl(url, state)) {
      shell.openExternal(url);
    } else if (url) {
      sendLog(`Blocked channel URL: ${url}`);
    }
  }
});

ipcMain.handle('generate-schedule', (event, payload) => {
  const { days, videosPerDay } = payload;
  const state = loadState();
  const selectedChannels = (state.channels || []).filter(isChannelSelected);
  const schedules = generateSchedule({
    days,
    videosPerDay,
    channels: selectedChannels,
  });

  const updated = updateState((stateMut) => {
    stateMut.schedules = {
      ...(stateMut.schedules || {}),
      ...schedules,
    };
    stateMut.settings = {
      ...stateMut.settings,
      days,
      videosPerDay,
    };
    return stateMut;
  });

  sendState(updated);
  return schedules;
});

ipcMain.handle('auto-assign', () => {
  const state = loadState();
  const selectedChannels = (state.channels || []).filter(isChannelSelected);
  const updatedSchedules = autoAssignVideos({
    schedules: state.schedules,
    channels: selectedChannels,
    videos: state.videos,
    settings: state.settings,
  });

  const updated = updateState((stateMut) => {
    stateMut.schedules = updatedSchedules;
    return stateMut;
  });

  sendState(updated);
  return updated;
});

ipcMain.handle('update-settings', (event, payload) => {
  const updated = updateState((state) => {
    const nextPayload = { ...(payload || {}) };
    if (nextPayload.globalDescription !== undefined) {
      nextPayload.defaultDescription = nextPayload.globalDescription;
    }
    if (nextPayload.titlePool !== undefined) {
      nextPayload.titlePool = parseTitleLines(nextPayload.titlePool);
    }
    if (nextPayload.driveApiKey !== undefined) {
      const rawDrive = String(nextPayload.driveApiKey || '').trim();
      nextPayload.driveApiKey = rawDrive ? encryptObject(rawDrive) : '';
    }
    if (nextPayload.youtubeApiKey !== undefined) {
      const rawYoutube = String(nextPayload.youtubeApiKey || '').trim();
      nextPayload.youtubeApiKey = rawYoutube ? encryptObject(rawYoutube) : '';
    }
    if (nextPayload.slots !== undefined) {
      nextPayload.slots = normalizeSlotPlan(nextPayload.slots);
      const fromPlan = deriveAutomationSlotsFromPlan(nextPayload.slots);
      if (fromPlan.length) {
        nextPayload.automationSlots = fromPlan;
      }
    }
    if (nextPayload.automationSlots !== undefined) {
      const normalizedSlots = Array.isArray(nextPayload.automationSlots)
        ? nextPayload.automationSlots.map(normalizeTimeSlot).filter(Boolean)
        : [];
      nextPayload.automationSlots = normalizedSlots.length ? [...new Set(normalizedSlots)].sort() : getAutomationSlots(state);
    }

    state.settings = {
      ...(state.settings || {}),
      ...nextPayload,
    };
    state.settings.videosPerDay = Math.max(1, Math.min(5, Number(state.settings.videosPerDay || 1)));
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return sanitizeState(updated);
});

ipcMain.handle('apply-global-metadata-to-videos', () => {
  const updated = updateState((state) => {
    const tags = parseTags(state.settings?.globalTags || '');
    const description = String(state.settings?.globalDescription || state.settings?.defaultDescription || '').trim();
    (state.videos || []).forEach((video) => {
      video.tags = tags;
      video.description = description;
    });
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return sanitizeState(updated);
});

ipcMain.handle('update-schedule-item', (event, payload) => {
  const { channelId, itemId, videoPath, publishAt } = payload;
  const updated = updateState((state) => {
    const items = state.schedules[channelId] || [];
    const item = items.find((i) => i.id === itemId);
    if (item) {
      if (videoPath !== undefined) {
        item.videoPath = videoPath;
        item.status = 'pending';
      }
      if (publishAt !== undefined) {
        const dt = new Date(publishAt);
        if (!Number.isNaN(dt.getTime())) {
          item.publishAt = publishAt;
          item.date = formatDateOnly(dt);
          item.time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
          item.status = 'pending';
        }
      }
    }
    return state;
  });
  sendState(updated);
  return updated;
});

function toIsoWithLocalOffset(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offM = String(absOffset % 60).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
}

function formatDateOnly(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseScheduleStartDate(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() === year
      && date.getMonth() === (month - 1)
      && date.getDate() === day
    ) {
      date.setHours(0, 0, 0, 0);
      return date;
    }
    return null;
  }

  const displayMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (displayMatch) {
    const day = Number(displayMatch[1]);
    const month = Number(displayMatch[2]);
    const year = Number(displayMatch[3]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() === year
      && date.getMonth() === (month - 1)
      && date.getDate() === day
    ) {
      date.setHours(0, 0, 0, 0);
      return date;
    }
    return null;
  }

  return null;
}

function applyScheduleDateCascade(items, baseDate, fromDayIndex = 0) {
  const sortedItems = (items || []).slice().sort((a, b) => {
    if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
    return a.slotIndex - b.slotIndex;
  });

  sortedItems.forEach((item) => {
    if (!Number.isInteger(item?.dayIndex) || item.dayIndex < fromDayIndex) return;

    const slotTime = (item.time || '04:00').split(':');
    const hh = Number(slotTime[0]) || 4;
    const mm = Number(slotTime[1]) || 0;
    const nextDate = new Date(baseDate);
    nextDate.setDate(baseDate.getDate() + (item.dayIndex - fromDayIndex));
    nextDate.setHours(hh, mm, 0, 0);

    item.date = formatDateOnly(nextDate);
    item.time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    item.publishAt = toIsoWithLocalOffset(nextDate);
    item.status = 'pending';
  });
}

ipcMain.handle('set-schedule-start-date', (event, payload) => {
  const { channelId, startDate } = payload || {};
  const base = parseScheduleStartDate(startDate);
  if (!channelId || !base || Number.isNaN(base.getTime())) {
    throw new Error('Invalid start date');
  }

  const updated = updateState((state) => {
    const items = (state.schedules?.[channelId] || []).slice().sort((a, b) => {
      if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
      return a.slotIndex - b.slotIndex;
    });
    applyScheduleDateCascade(items, base, 0);
    return state;
  });

  sendState(updated);
  return updated;
});

ipcMain.handle('set-schedule-day-date', (event, payload) => {
  const { channelId, dayIndex, startDate } = payload || {};
  const base = parseScheduleStartDate(startDate);
  const safeDayIndex = Number(dayIndex);
  if (!channelId || !base || Number.isNaN(base.getTime()) || !Number.isInteger(safeDayIndex) || safeDayIndex < 0) {
    throw new Error('Invalid day date payload');
  }

  const updated = updateState((state) => {
    const items = (state.schedules?.[channelId] || []).slice().sort((a, b) => {
      if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
      return a.slotIndex - b.slotIndex;
    });
    applyScheduleDateCascade(items, base, safeDayIndex);
    return state;
  });

  sendState(updated);
  return updated;
});

ipcMain.handle('start-upload', async () => {
  const state = loadState();
  const preflight = runAutomationPreflight(state);
  if (!preflight.ok) {
    throw new Error(`Preflight failed: ${preflight.errors.join(' ')}`);
  }
  return runUploadCycle({ keepAutomationRunning: false, origin: 'manual-start' });
});

ipcMain.handle('stop-upload', async () => {
  uploader.requestStop();
  const updated = loadState();
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog('Stop requested. Current upload will stop safely.');
  return { stopped: true };
});

ipcMain.handle('check-internet', async () => {
  const ok = await checkInternet();
  return ok;
});

ipcMain.handle('get-automation-upgrade-status', () => {
  return getAutomationUpgradeStatus();
});

ipcMain.handle('preflight-automation', () => {
  const state = loadState();
  return runAutomationPreflight(state);
});

ipcMain.handle('start-automation', async () => {
  const stateBeforeStart = loadState();
  const preflight = runAutomationPreflight(stateBeforeStart);
  if (!preflight.ok) {
    throw new Error(`Preflight failed: ${preflight.errors.join(' ')}`);
  }
  const updated = updateState((state) => {
    state.settings = state.settings || {};
    state.settings.automationRunning = true;
    state.settings.automationStartedAt = new Date().toISOString();
    state.settings.automationStoppedAt = '';
    state.settings.videosPerDay = Math.max(1, Math.min(5, Number(state.settings.videosPerDay || 5)));
    state.settings.automationSlots = getAutomationSlots(state);
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog(`Automation enabled. Daily slots: ${getAutomationSlots(updated).join(', ')}`);
  setTimeout(() => {
    runUploadCycle({ keepAutomationRunning: true, origin: 'automation-start' }).catch((error) => {
      sendLog(`Automation start warning: ${error?.message || error}`);
    });
  }, 250);
  return { automationRunning: true };
});

ipcMain.handle('stop-automation', async () => {
  uploader.requestStop();
  const updated = updateState((state) => {
    state.settings = state.settings || {};
    state.settings.automationRunning = false;
    state.settings.automationStoppedAt = new Date().toISOString();
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  sendLog('Automation stopped.');
  return { automationRunning: false };
});

ipcMain.handle('set-videos-per-day', async (event, videosPerDay) => {
  const value = Math.max(1, Math.min(5, Number(videosPerDay || 1)));
  const updated = updateState((state) => {
    state.settings = state.settings || {};
    state.settings.videosPerDay = value;
    return state;
  });
  syncAutomationDatabaseFromState(updated);
  sendState(updated);
  return { videosPerDay: value };
});

ipcMain.handle('get-automation-status', async () => {
  const state = loadState();
  const pending = (state.videos || []).filter((video) => video.status === 'pending').length;
  const uploaded = (state.videos || []).filter((video) => video.status === 'uploaded').length;
  return {
    automationRunning: Boolean(state.settings?.automationRunning),
    uploadInProgress: Boolean(state.settings?.uploadInProgress || uploadInProgress),
    videosPerDay: Math.max(1, Math.min(5, Number(state.settings?.videosPerDay || 5))),
    automationSlots: getAutomationSlots(state),
    pending,
    uploaded,
  };
});
