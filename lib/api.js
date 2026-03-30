const DEFAULT_BASE_URL = "https://ganga-backend-production.up.railway.app";

export const API_BASE_URL = (window.localStorage.getItem("backend_url") || DEFAULT_BASE_URL).replace(/\/+$/, "");

function getToken() {
  return window.localStorage.getItem("auth_token") || "";
}

function buildHeaders(extra = {}) {
  const token = getToken();
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function parseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function apiRequest(path, options = {}) {
  const url = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    ...options,
    headers: buildHeaders(options.headers || {}),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const message = data?.error || data?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export const api = {
  stats: () => apiRequest("/api/stats"),
  channels: {
    list: () => apiRequest("/api/channels"),
    create: (payload) => apiRequest("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  },
  videos: {
    list: () => apiRequest("/api/videos"),
  },
  schedules: {
    list: () => apiRequest("/api/schedules"),
    create: (payload) => apiRequest("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  },
  automation: {
    status: () => apiRequest("/api/automation-status"),
    start: () => apiRequest("/api/start-automation", { method: "POST" }),
    stop: () => apiRequest("/api/stop-automation", { method: "POST" }),
  },
  uploadVideo: (formData) => apiRequest("/api/upload-video", {
    method: "POST",
    body: formData,
  }),
};
