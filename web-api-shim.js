(function () {
  const BASE_URL = "https://ganga-backend-production.up.railway.app";
  const SETTINGS_KEY = "gda_web_settings";
  const TOKEN_KEY = "auth_token";

  const callbacks = {
    onLog: [],
    onProgress: [],
    onDriveSyncProgress: [],
    onDriveUploadItem: [],
    onState: [],
  };

  function emit(name, payload) {
    const list = callbacks[name] || [];
    for (const cb of list) {
      try { cb(payload); } catch (_) {}
    }
  }

  function parseTokenFromUrl() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveSettings(patch) {
    const next = { ...getSettings(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!response.ok) {
      const msg = data?.error || data?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function getState() {
    const [stats, channelsResp, videosResp, schedulesResp, uploadStatus] = await Promise.all([
      request("/api/stats").catch(() => ({ total_channels: 0, total_videos: 0, total_scheduled: 0, connected_channels: 0 })),
      request("/api/channels").catch(() => ({ channels: [] })),
      request("/api/videos").catch(() => ({ videos: [] })),
      request("/api/schedules").catch(() => ({ schedules: [] })),
      request("/api/upload/status").catch(() => ({ is_running: false, pending: 0, uploaded_today: 0 })),
    ]);

    const settings = getSettings();

    const channels = (channelsResp.channels || []).map((c) => ({
      id: c.id,
      channel_name: c.name,
      channel_url: c.youtube_channel_url || "",
      youtube_url: c.youtube_channel_url || "",
      is_selected: settings.selectedChannels?.[c.id] !== false,
      token_status: c.status === "connected" ? "connected" : "disconnected",
      status: c.status,
    }));

    const videos = (videosResp.videos || []).map((v) => ({
      id: v.id,
      title: v.name,
      original_file_name: v.name,
      size: v.size_bytes,
      status: "pending",
      uploaded_channel_id: null,
      uploaded_at: null,
    }));

    const schedules = (schedulesResp.schedules || []).map((s) => ({
      ...s,
      channel_name: s.channel?.name || "",
      video_name: s.video?.name || "",
    }));

    return {
      channels,
      videos,
      schedules,
      settings: {
        videosPerDay: Number(settings.videosPerDay || 1),
        automationRunning: Boolean(uploadStatus.is_running),
        automationStartedAt: settings.automationStartedAt || "",
        automationStoppedAt: settings.automationStoppedAt || "",
        autoScheduleEnabled: Boolean(settings.autoScheduleEnabled),
        driveFolderLinks: Array.isArray(settings.driveFolderLinks) ? settings.driveFolderLinks : [],
        titlePool: Array.isArray(settings.titlePool) ? settings.titlePool : [],
        globalTags: String(settings.globalTags || ""),
        globalDescription: String(settings.globalDescription || ""),
        channelSlotPlans: settings.channelSlotPlans || {},
      },
      stats: {
        total_channels: stats.total_channels || channels.length,
        total_videos: stats.total_videos || videos.length,
        total_scheduled: stats.total_scheduled || schedules.length,
        connected_channels: stats.connected_channels || 0,
      },
    };
  }

  const api = {
    async getState() {
      return getState();
    },
    async updateSettings(patch) {
      return saveSettings(patch || {});
    },
    async setVideosPerDay(value) {
      saveSettings({ videosPerDay: value });
      return { success: true };
    },
    async setChannelSelected({ channelId, selected }) {
      const current = getSettings();
      const selectedChannels = { ...(current.selectedChannels || {}), [channelId]: Boolean(selected) };
      saveSettings({ selectedChannels });
      return { success: true };
    },
    async startAutomation() {
      const res = await request("/api/start-automation", { method: "POST" });
      saveSettings({ automationStartedAt: new Date().toISOString(), automationStoppedAt: "" });
      emit("onLog", "Automation started");
      return res;
    },
    async stopAutomation() {
      const res = await request("/api/stop-automation", { method: "POST" });
      saveSettings({ automationStoppedAt: new Date().toISOString() });
      emit("onLog", "Automation stopped");
      return res;
    },
    async preflightAutomation() {
      return { ok: true, errors: [] };
    },
    async getAutomationStatus() {
      const status = await request("/api/upload/status");
      return {
        automationRunning: Boolean(status.is_running),
        uploadInProgress: false,
        pendingVideos: Number(status.pending || 0),
        uploadedToday: Number(status.uploaded_today || 0),
      };
    },
    async startUpload() {
      return request("/api/upload/start", { method: "POST" });
    },
    async stopUpload() {
      return request("/api/upload/stop", { method: "POST" });
    },
    async addChannel(payload) {
      const name = payload.channelUrl || payload.channel_url || payload.name || "Channel";
      const body = {
        name,
        client_id: payload.clientId || payload.client_id || "",
        client_secret: payload.clientSecret || payload.client_secret || "",
      };
      const created = await request("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      emit("onLog", `Channel added: ${created.name || name}`);
      return created;
    },
    async deleteChannel(id) {
      const res = await request(`/api/channels/${id}`, { method: "DELETE" });
      emit("onLog", "Channel removed");
      return res;
    },
    async openChannel(id) {
      const channel = await request(`/api/channels/${id}`);
      if (channel.youtube_channel_url) window.open(channel.youtube_channel_url, "_blank");
      return { success: true };
    },
    async getChannelToken(_id) {
      window.location.href = `${BASE_URL}/api/auth/google/start`;
      return { success: true };
    },
    async fetchDriveVideos() {
      const videos = await request("/api/videos");
      return { success: true, videos: videos.videos || [] };
    },
    async uploadVideosToDrive() {
      throw new Error("Browser mode: use Video Library upload API flow");
    },
    async deleteAllDriveVideos() {
      return request("/api/videos", { method: "DELETE" });
    },
    async autoAssignVideoTitles() { return { success: true }; },
    async applyGlobalMetadataToVideos() { return { success: true }; },
    async getAutomationUpgradeStatus() {
      return {
        status: "ready",
        foldersReady: true,
        apiReady: true,
        workflowReady: true,
        queueCount: 0,
      };
    },
    async checkInternet() {
      try {
        await request("/health");
        return true;
      } catch {
        return false;
      }
    },
    async getAppMeta() { return { version: "web" }; },
    async checkForUpdates() { return { ok: true }; },
    async getUpdateStatus() { return { stage: "idle", message: "Web mode" }; },
    async installDownloadedUpdate() { return { ok: false }; },
    async openExternal(url) { window.open(url, "_blank"); return true; },
    async selectOAuthJson() { return ""; },

    onLog(cb) { callbacks.onLog.push(cb); },
    onProgress(cb) { callbacks.onProgress.push(cb); },
    onDriveSyncProgress(cb) { callbacks.onDriveSyncProgress.push(cb); },
    onDriveUploadItem(cb) { callbacks.onDriveUploadItem.push(cb); },
    onState(cb) { callbacks.onState.push(cb); },
  };

  parseTokenFromUrl();
  window.api = api;

  setInterval(async () => {
    if (!callbacks.onState.length) return;
    try {
      const current = await getState();
      emit("onState", current);
    } catch (_) {}
  }, 10000);
})();
