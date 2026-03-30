import { api, API_BASE_URL } from "/lib/api.js";

const state = {
  channels: [],
  videos: [],
  schedules: [],
};

const nodes = {
  loginScreen: document.getElementById("login-screen"),
  appScreen: document.getElementById("app-screen"),
  loginBtn: document.getElementById("google-login-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  userEmail: document.getElementById("user-email"),
  backendUrl: document.getElementById("backend-url"),
  message: document.getElementById("global-message"),

  statChannels: document.getElementById("stat-channels"),
  statVideos: document.getElementById("stat-videos"),
  statScheduled: document.getElementById("stat-scheduled"),
  statConnected: document.getElementById("stat-connected"),
  automationStatus: document.getElementById("automation-status"),

  channelsList: document.getElementById("channels-list"),
  channelName: document.getElementById("channel-name"),
  channelClientId: document.getElementById("channel-client-id"),
  channelClientSecret: document.getElementById("channel-client-secret"),
  createChannelBtn: document.getElementById("create-channel-btn"),

  uploadTitle: document.getElementById("upload-title"),
  uploadDescription: document.getElementById("upload-description"),
  uploadTags: document.getElementById("upload-tags"),
  uploadFile: document.getElementById("upload-file"),
  uploadBtn: document.getElementById("upload-btn"),
  uploadResult: document.getElementById("upload-result"),

  scheduleChannel: document.getElementById("schedule-channel"),
  scheduleVideo: document.getElementById("schedule-video"),
  scheduleDatetime: document.getElementById("schedule-datetime"),
  addScheduleBtn: document.getElementById("add-schedule-btn"),
  schedulesList: document.getElementById("schedules-list"),

  startAutomationBtn: document.getElementById("start-automation-btn"),
  stopAutomationBtn: document.getElementById("stop-automation-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
};

function showMessage(message, isError = false) {
  nodes.message.textContent = message || "";
  nodes.message.style.color = isError ? "#fb7185" : "#7dd3fc";
}

function getToken() {
  return window.localStorage.getItem("auth_token") || "";
}

function setToken(token) {
  if (!token) return;
  window.localStorage.setItem("auth_token", token);
}

function clearToken() {
  window.localStorage.removeItem("auth_token");
}

function decodeJwtPayload(token) {
  if (!token || token.split(".").length < 2) return null;
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(normalized)
        .split("")
        .map((ch) => `%${`00${ch.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function applyTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  setToken(token);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function updateAuthView() {
  const token = getToken();
  const isAuthed = Boolean(token);
  nodes.loginScreen.classList.toggle("hidden", isAuthed);
  nodes.appScreen.classList.toggle("hidden", !isAuthed);

  if (!isAuthed) return;

  const payload = decodeJwtPayload(token);
  nodes.userEmail.textContent = payload?.email || "Signed in";
  nodes.backendUrl.textContent = API_BASE_URL;
}

function renderStats(stats) {
  nodes.statChannels.textContent = String(stats.total_channels || 0);
  nodes.statVideos.textContent = String(stats.total_videos || 0);
  nodes.statScheduled.textContent = String(stats.total_scheduled || 0);
  nodes.statConnected.textContent = String(stats.connected_channels || 0);
}

function renderChannels() {
  if (!nodes.channelsList) return;
  if (!state.channels.length) {
    nodes.channelsList.innerHTML = '<div class="item muted">No channels yet.</div>';
    return;
  }

  nodes.channelsList.innerHTML = state.channels
    .map((channel) => {
      const name = channel.name || "Untitled";
      const status = channel.status || "unknown";
      return `<div class="item"><strong>${name}</strong><div class="muted">Status: ${status}</div></div>`;
    })
    .join("");
}

function renderVideosSelect() {
  if (!nodes.scheduleVideo) return;
  nodes.scheduleVideo.innerHTML = "";

  state.videos.forEach((video) => {
    const option = document.createElement("option");
    option.value = video.id;
    option.textContent = video.name;
    nodes.scheduleVideo.appendChild(option);
  });
}

function renderChannelsSelect() {
  if (!nodes.scheduleChannel) return;
  nodes.scheduleChannel.innerHTML = "";

  state.channels.forEach((channel) => {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = channel.name;
    nodes.scheduleChannel.appendChild(option);
  });
}

function renderSchedules() {
  if (!nodes.schedulesList) return;
  if (!state.schedules.length) {
    nodes.schedulesList.innerHTML = '<div class="item muted">No schedules yet.</div>';
    return;
  }

  nodes.schedulesList.innerHTML = state.schedules
    .map((s) => {
      const channelName = s.channel?.name || s.channel_id;
      const videoName = s.video?.name || s.video_id;
      return `<div class="item"><strong>${videoName}</strong><div class="muted">${channelName} · ${new Date(s.scheduled_at).toLocaleString()} · ${s.status}</div></div>`;
    })
    .join("");
}

async function loadDashboardData() {
  const [stats, channelsData, videosData, schedulesData, automationData] = await Promise.all([
    api.stats(),
    api.channels.list(),
    api.videos.list(),
    api.schedules.list(),
    api.automation.status(),
  ]);

  state.channels = channelsData.channels || [];
  state.videos = videosData.videos || [];
  state.schedules = schedulesData.schedules || [];

  renderStats(stats);
  renderChannels();
  renderChannelsSelect();
  renderVideosSelect();
  renderSchedules();
  nodes.automationStatus.textContent = `Running: ${automationData.is_running ? "Yes" : "No"} | Pending: ${automationData.pending_videos || 0} | Uploaded: ${automationData.uploaded_videos || 0}`;
}

function setupNav() {
  const links = document.querySelectorAll(".nav-link");
  const pages = document.querySelectorAll(".page");
  links.forEach((link) => {
    link.addEventListener("click", () => {
      links.forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
      const page = link.getAttribute("data-page");
      pages.forEach((section) => {
        section.classList.toggle("active", section.id === `page-${page}`);
      });
    });
  });
}

function wireActions() {
  nodes.loginBtn?.addEventListener("click", () => {
    window.location.href = `${API_BASE_URL}/api/auth/google/start`;
  });

  nodes.logoutBtn?.addEventListener("click", () => {
    clearToken();
    updateAuthView();
    showMessage("Logged out");
  });

  nodes.refreshBtn?.addEventListener("click", async () => {
    try {
      await loadDashboardData();
      showMessage("Data refreshed");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  nodes.createChannelBtn?.addEventListener("click", async () => {
    const name = String(nodes.channelName.value || "").trim();
    const client_id = String(nodes.channelClientId.value || "").trim();
    const client_secret = String(nodes.channelClientSecret.value || "").trim();

    if (!name || !client_id || !client_secret) {
      showMessage("Channel name, client ID and client secret are required", true);
      return;
    }

    try {
      await api.channels.create({ name, client_id, client_secret });
      nodes.channelName.value = "";
      nodes.channelClientId.value = "";
      nodes.channelClientSecret.value = "";
      await loadDashboardData();
      showMessage("Channel connected successfully");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  nodes.uploadBtn?.addEventListener("click", async () => {
    const file = nodes.uploadFile.files?.[0];
    const title = String(nodes.uploadTitle.value || "").trim();
    const description = String(nodes.uploadDescription.value || "").trim();
    const tags = String(nodes.uploadTags.value || "").trim();

    if (!file || !title) {
      showMessage("Video file and title are required", true);
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", title);
    formData.append("description", description);
    formData.append("tags", tags);

    try {
      const result = await api.uploadVideo(formData);
      nodes.uploadResult.textContent = `Queued: ${result?.video?.title || title}`;
      nodes.uploadTitle.value = "";
      nodes.uploadDescription.value = "";
      nodes.uploadTags.value = "";
      nodes.uploadFile.value = "";
      showMessage("Video upload request sent");
    } catch (error) {
      nodes.uploadResult.textContent = "";
      showMessage(error.message, true);
    }
  });

  nodes.addScheduleBtn?.addEventListener("click", async () => {
    const channel_id = nodes.scheduleChannel.value;
    const video_id = nodes.scheduleVideo.value;
    const datetime = nodes.scheduleDatetime.value;

    if (!channel_id || !video_id || !datetime) {
      showMessage("Channel, video and date-time are required", true);
      return;
    }

    try {
      await api.schedules.create({
        channel_id,
        video_id,
        scheduled_at: new Date(datetime).toISOString(),
      });
      await loadDashboardData();
      showMessage("Schedule added successfully");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  nodes.startAutomationBtn?.addEventListener("click", async () => {
    try {
      await api.automation.start();
      await loadDashboardData();
      showMessage("Automation started");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  nodes.stopAutomationBtn?.addEventListener("click", async () => {
    try {
      await api.automation.stop();
      await loadDashboardData();
      showMessage("Automation stopped");
    } catch (error) {
      showMessage(error.message, true);
    }
  });
}

async function boot() {
  applyTokenFromUrl();
  setupNav();
  wireActions();
  updateAuthView();

  if (!getToken()) return;

  try {
    await loadDashboardData();
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("unauthorized") || String(error.message || "").toLowerCase().includes("invalid token")) {
      clearToken();
      updateAuthView();
      showMessage("Session expired, please login again", true);
      return;
    }
    showMessage(error.message, true);
  }
}

boot();
