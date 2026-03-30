const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_STATE = {
  videos: [],
  videoFolder: null,
  channels: [],
  schedules: {},
  uploads: [],
  settings: {
    defaultTitlePrefix: '',
    defaultDescription: 'Uploaded via Ganga Digital Automation',
    globalDescription: 'Uploaded via Ganga Digital Automation',
    globalTags: '',
    titlePool: [],
    youtubeApiKey: '',
    driveApiKey: '',
    videosPerDay: 5,
    automationRunning: false,
    uploadInProgress: false,
    automationSlots: ['00:10', '06:30', '10:00', '16:00', '22:00'],
    autoScheduleEnabled: true,
    selectedAutomationChannelIds: [],
    schedulerConfig: {
      minGapHours: 2,
      maxGapHours: 6,
      timeVariationMinutes: 30,
      enableDailyShift: true,
    },
    channelSlotPlans: {},
    uploadedVideosByChannel: {},
    automationIntelligence: {},
  },
  logs: [],
};

function getStorePath() {
  const dir = app.getPath('userData');
  return path.join(dir, 'store.json');
}

function normalizeVideo(video) {
  if (!video || typeof video !== 'object') return null;

  if (video.drive_file_id) {
    return {
      id: String(video.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      drive_file_id: String(video.drive_file_id),
      drive_link: String(video.drive_link || ''),
      title: String(video.title || video.name || 'Untitled Video'),
      assigned_title: String(video.assigned_title || video.title || ''),
      original_file_name: String(video.original_file_name || video.name || ''),
      size: Number(video.size || 0),
      description: String(video.description || ''),
      tags: Array.isArray(video.tags) ? video.tags : [],
      status: video.status === 'uploaded' ? 'uploaded' : 'pending',
      upload_count: Number(video.upload_count || 0),
      created_at: video.created_at || new Date().toISOString(),
      uploaded_at: video.uploaded_at || null,
      youtube_video_id: video.youtube_video_id || null,
      last_error: video.last_error || null,
    };
  }

  // Migrate old local-file videos to pending records without drive id.
  return {
    id: String(video.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    drive_file_id: '',
    drive_link: '',
    title: String(video.title || video.name || 'Untitled Video'),
    assigned_title: String(video.assigned_title || video.title || ''),
    original_file_name: String(video.original_file_name || video.name || ''),
    size: Number(video.size || 0),
    description: String(video.description || ''),
    tags: Array.isArray(video.tags) ? video.tags : [],
    status: video.status === 'uploaded' ? 'uploaded' : 'pending',
    upload_count: Number(video.upload_count || 0),
    created_at: video.created_at || new Date().toISOString(),
    uploaded_at: video.uploaded_at || null,
    youtube_video_id: video.youtube_video_id || null,
    last_error: video.last_error || null,
  };
}

function normalizeChannel(channel) {
  if (!channel || typeof channel !== 'object') return null;
  const selected = channel?.is_selected !== undefined
    ? Boolean(channel.is_selected)
    : channel?.selected !== false;

  return {
    ...channel,
    channel_name: channel.channel_name || channel.title || channel.label || 'Untitled Channel',
    youtube_url: channel.youtube_url || channel.channelUrl || '',
    token_status: channel.token_status === 'connected' ? 'connected' : 'not_connected',
    is_selected: selected,
    selected,
  };
}

function loadState() {
  const file = getStorePath();
  try {
    if (!fs.existsSync(file)) {
      return { ...DEFAULT_STATE };
    }
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_STATE, ...parsed };
    merged.channels = (merged.channels || []).map(normalizeChannel).filter(Boolean);
    merged.settings = {
      ...DEFAULT_STATE.settings,
      ...(merged.settings || {}),
    };
    merged.settings.videosPerDay = Math.max(1, Math.min(5, Number(merged.settings.videosPerDay || 1)));
    merged.settings.automationRunning = Boolean(merged.settings.automationRunning);
    merged.videos = (merged.videos || []).map(normalizeVideo).filter(Boolean);
    return merged;
  } catch (err) {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  const file = getStorePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function updateState(mutator) {
  const state = loadState();
  const updated = mutator(state) || state;
  saveState(updated);
  return updated;
}

module.exports = {
  loadState,
  saveState,
  updateState,
};
