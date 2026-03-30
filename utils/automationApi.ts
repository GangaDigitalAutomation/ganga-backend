import { apiGet, apiPost } from './api';

export async function connectChannelStart(channel_name?: string) {
  return apiPost('/connect-channel', { channel_name });
}

export async function connectChannelComplete(code: string, state: string) {
  return apiPost('/connect-channel', { code, state });
}

export async function uploadVideoWithDriveLink(payload: {
  drive_link: string;
  title: string;
  description?: string;
  tags?: string[] | string;
}) {
  return apiPost('/upload-video', payload);
}

export async function getAutomationQueueVideos() {
  return apiGet('/videos');
}

export async function startAutomation() {
  return apiPost('/start-automation');
}

export async function stopAutomation() {
  return apiPost('/stop-automation');
}

export async function getAutomationStatus() {
  return apiGet('/api/automation-status');
}
