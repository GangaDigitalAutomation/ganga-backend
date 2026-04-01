const state = {
  data: null,
  slots: [],
  channelSlotPlans: {},
  selectedScheduleChannelId: '',
  automationStatus: {
    automationRunning: false,
    uploadInProgress: false,
  },
  driveAuth: {
    connected: false,
    email: '',
  },
  driveFolders: [],
  driveFolderData: {},
  driveFolderOptions: [],
  tagChips: [],
  autoScheduleEnabled: false,
  selectedSlotKey: '',
  appMeta: null,
  updater: null,
  seenUploadedVideoIds: new Set(),
  uploadSeenInitialized: false,
  systemLogKeys: new Set(),
  uploadSummary: {
    totalVideos: 0,
    completedVideos: 0,
    totalBytes: 0,
    uploadedBytes: 0,
  },
  ai: {
    messages: [],
    systemData: null,
    lastError: '',
    lastAction: null,
  },
};

let driveAutoRefreshTimer = null;
let autosaveTimer = null;

const pages = document.querySelectorAll('.page');
const navLinks = document.querySelectorAll('.nav-link');

navLinks.forEach((link) => {
  link.addEventListener('click', () => {
    navLinks.forEach((btn) => btn.classList.remove('active'));
    link.classList.add('active');
    const page = link.dataset.page;
    pages.forEach((section) => {
      section.classList.toggle('active', section.id === `page-${page}`);
    });
    if (page === 'library') {
      refreshDriveAuthStatus();
      refreshDriveFolderOptions();
      loadConnectedDriveFolders();
      fetchDriveVideos();
      startDriveAutoRefresh();
    }
    if (page === 'ai') {
      refreshAiSystemData();
    }
  });
});

function isLibraryPageActive() {
  return document.getElementById('page-library')?.classList.contains('active');
}

function isAiPageActive() {
  return document.getElementById('page-ai')?.classList.contains('active');
}

function startDriveAutoRefresh() {
  if (driveAutoRefreshTimer) return;
  driveAutoRefreshTimer = setInterval(() => {
    if (!isLibraryPageActive()) return;
    fetchDriveVideos({ silent: true });
  }, 10000);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function parseTitleLines(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTagsFromString(raw) {
  return String(raw || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function renderTagChips() {
  const list = document.getElementById('tags-chip-list');
  const hiddenInput = document.getElementById('global-tags-input');
  if (!list || !hiddenInput) return;
  list.innerHTML = '';
  state.tagChips.forEach((tag, index) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `
      <span>${escapeHtml(tag)}</span>
      <button type="button" data-action="remove-tag" data-index="${index}" aria-label="Remove tag">x</button>
    `;
    chip.querySelector('[data-action="remove-tag"]')?.addEventListener('click', () => {
      state.tagChips.splice(index, 1);
      renderTagChips();
    });
    list.appendChild(chip);
  });
  hiddenInput.value = state.tagChips.join(', ');
}

function extractDriveFolderId(link) {
  const value = String(link || '').trim();
  if (!value) return '';
  const fromPath = value.match(/\/drive\/folders\/([a-zA-Z0-9_-]+)/)?.[1]
    || value.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  if (fromPath) return fromPath;
  try {
    const url = new URL(value);
    return url.searchParams.get('id') || '';
  } catch (error) {
    return '';
  }
}

function addLog(message) {
  const normalized = normalizeSystemLogMessage(message);
  if (!normalized) return;
  const list = document.getElementById('log-list');
  if (!list) return;
  if (state.systemLogKeys.has(normalized)) return;
  state.systemLogKeys.add(normalized);
  const item = document.createElement('div');
  item.className = 'log-entry';
  item.textContent = `[${new Date().toLocaleTimeString()}] ${normalized}`;
  list.prepend(item);
}

function normalizeSystemLogMessage(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  if (text.startsWith('?') || text.startsWith('?')) {
    return text;
  }
  if (text.includes('[UPLOAD_COMPLETE]')) {
    return `? ${text.replace('[UPLOAD_COMPLETE]', '').trim()} uploaded successfully`;
  }
  if (text.includes('[UPLOAD_FAILED]')) {
    return `? ${text.replace('[UPLOAD_FAILED]', '').trim()}`;
  }
  return '';
}

function toLocalDateKey(value = new Date()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isUploadedToday(video) {
  const stamp = String(video?.uploaded_at || '').trim();
  if (!stamp) return false;
  return toLocalDateKey(stamp) === toLocalDateKey(new Date());
}

function formatTopDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = String(date.getFullYear());
  return `${d}-${m}-${y}`;
}

function formatTopTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatShortDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = String(date.getFullYear());
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${d}-${m}-${y} ${hh}:${mm}`;
}

function renderAutomationTopSection() {
  const startRow = document.getElementById('automation-top-start-row');
  const runningRow = document.getElementById('automation-top-running-row');
  const stoppedRow = document.getElementById('automation-top-stopped-row');
  if (!startRow || !runningRow || !stoppedRow) return;

  const settings = state.data?.settings || {};
  const running = Boolean(settings.automationRunning);
  const startedAt = settings.automationStartedAt || '';
  const stoppedAt = settings.automationStoppedAt || '';

  document.getElementById('automation-start-date').textContent = formatTopDate(startedAt);
  document.getElementById('automation-start-time').textContent = formatTopTime(startedAt);
  document.getElementById('automation-stop-date').textContent = formatTopDate(stoppedAt);
  document.getElementById('automation-stop-time').textContent = formatTopTime(stoppedAt);

  if (running) {
    startRow.classList.add('hidden');
    runningRow.classList.remove('hidden');
    stoppedRow.classList.add('hidden');
    return;
  }

  startRow.classList.remove('hidden');
  runningRow.classList.add('hidden');
  stoppedRow.classList.toggle('hidden', !stoppedAt);
}

function renderChannelUploadTracker() {
  const wrap = document.getElementById('channel-upload-tracker');
  if (!wrap) return;
  const channels = Array.isArray(state.data?.channels) ? state.data.channels : [];
  const selected = channels.filter(isChannelSelected);
  const active = selected.length ? selected : channels;
  const perDay = Math.max(1, Math.min(5, Number(state.data?.settings?.videosPerDay || 1)));
  const videos = Array.isArray(state.data?.videos) ? state.data.videos : [];
  const uploadedToday = videos.filter((video) => video.status === 'uploaded' && isUploadedToday(video));
  const counts = new Map();
  uploadedToday.forEach((video) => {
    const key = String(video.uploaded_channel_id || '').trim();
    if (!key) return;
    counts.set(key, Number(counts.get(key) || 0) + 1);
  });

  if (!active.length) {
    wrap.innerHTML = '<p class="hint">No channels connected.</p>';
    return;
  }

  wrap.innerHTML = active.map((channel, idx) => {
    const channelId = String(channel.id || channel.channel_id || `channel_${idx + 1}`);
    const name = escapeHtml(channel.channel_name || channel.title || channel.label || `Channel ${idx + 1}`);
    const uploaded = Math.min(perDay, Number(counts.get(channelId) || 0));
    const dots = Array.from({ length: perDay }, (_, dotIndex) => (
      `<span class="tracker-dot ${dotIndex < uploaded ? 'done' : ''}"></span>`
    )).join('');
    return `
      <div class="tracker-row">
        <div class="tracker-name">${name}</div>
        <div class="tracker-dots">${dots}</div>
      </div>
    `;
  }).join('');
}

function captureUploadedEvents(data) {
  const videos = Array.isArray(data?.videos) ? data.videos : [];
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  const channelMap = new Map(channels.map((ch) => [String(ch.id || '').trim(), ch.channel_name || ch.title || ch.label || 'Channel']));
  const uploadedVideos = videos.filter((video) => video.status === 'uploaded' && String(video.id || '').trim());
  const currentIds = new Set(uploadedVideos.map((video) => String(video.id || '').trim()));

  if (!state.uploadSeenInitialized) {
    state.seenUploadedVideoIds = currentIds;
    state.uploadSeenInitialized = true;
    return;
  }

  uploadedVideos.forEach((video) => {
    const id = String(video.id || '').trim();
    if (!id || state.seenUploadedVideoIds.has(id)) return;
    const channelName = channelMap.get(String(video.uploaded_channel_id || '').trim()) || 'Unknown Channel';
    const title = String(video.assigned_title || video.title || video.original_file_name || id).trim();
    addLog(`? "${title}" uploaded successfully (${channelName})`);
  });
  state.seenUploadedVideoIds = currentIds;
}

function titleCaseUpdateStage(stage) {
  return String(stage || 'idle')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderUpdateCard() {
  const statusPill = document.getElementById('app-update-status');
  const messageEl = document.getElementById('app-update-message');
  const currentEl = document.getElementById('app-current-version');
  const availableEl = document.getElementById('app-available-version');
  const installBtn = document.getElementById('install-update-btn');

  if (!statusPill || !messageEl || !currentEl || !availableEl || !installBtn) return;

  const updater = state.updater || {};
  const metaVersion = state.appMeta?.version || '--';
  const currentVersion = updater.currentVersion || metaVersion;

  statusPill.textContent = titleCaseUpdateStage(updater.stage || 'idle');
  messageEl.textContent = updater.message || 'Update status not available.';
  currentEl.textContent = currentVersion;
  availableEl.textContent = updater.availableVersion || '--';
  installBtn.disabled = !Boolean(updater.downloaded);
}

function isChannelSelected(channel) {
  return channel?.is_selected !== false && channel?.selected !== false;
}

function getScheduleChannelId(channel, index = 0) {
  return String(
    channel?.id
    || channel?.channel_id
    || channel?.channelId
    || channel?.youtube_channel_id
    || channel?.youtubeId
    || `channel_${index + 1}`
  );
}

function getScheduleChannels() {
  const channels = Array.isArray(state.data?.channels) ? state.data.channels : [];
  return channels.map((channel, index) => ({ ...channel, _scheduleId: getScheduleChannelId(channel, index) }));
}

function getScheduleChannelName(channel) {
  return channel?.channel_name || channel?.title || channel?.label || 'Untitled Channel';
}

function ensureSelectedScheduleChannel() {
  const channels = getScheduleChannels();
  if (!channels.length) {
    state.selectedScheduleChannelId = '';
    return null;
  }

  const hasSelected = channels.some((channel) => channel._scheduleId === state.selectedScheduleChannelId);
  if (!hasSelected) {
    state.selectedScheduleChannelId = channels[0]._scheduleId;
  }
  return channels.find((channel) => channel._scheduleId === state.selectedScheduleChannelId) || channels[0];
}

function renderVideos() {
  const container = document.getElementById('drive-folders-container');
  if (!container) return;
  container.innerHTML = '';

  const folderRows = state.driveFolders.map((folderLink) => {
    const folderId = extractDriveFolderId(folderLink);
    const bucket = state.driveFolderData[folderId] || { videos: [], error: '' };
    return {
      folderId,
      folderLink,
      videos: Array.isArray(bucket.videos) ? bucket.videos : [],
      error: String(bucket.error || ''),
    };
  });

  const totalVideos = folderRows.reduce((acc, folder) => acc + folder.videos.length, 0);
  const videoCountLabel = document.getElementById('library-video-count');
  if (videoCountLabel) videoCountLabel.textContent = `Total Videos: ${totalVideos}`;
  const videoCountTop = document.getElementById('library-video-count-top');
  if (videoCountTop) videoCountTop.textContent = `Total Videos: ${totalVideos}`;

  const folderLinkInput = document.getElementById('drive-folder-link-input');
  if (folderLinkInput && state.driveFolders.length === 1 && !folderLinkInput.value) {
    folderLinkInput.value = state.driveFolders[0];
  }

  renderTagChips();

  const emptyState = document.getElementById('video-empty-state');
  if (emptyState) {
    emptyState.classList.toggle('hidden', totalVideos > 0 || folderRows.length > 0);
  }

  folderRows.forEach((folder, folderIndex) => {
    const card = document.createElement('div');
    card.className = 'glass-card table';
    card.style.marginBottom = '12px';

    const header = document.createElement('div');
    header.className = 'page-header';
    header.style.marginBottom = '8px';
    header.innerHTML = `
      <div>
        <p class="section-count">Folder ${folderIndex + 1}</p>
        <p class="section-count">Total Videos: ${folder.videos.length}</p>
      </div>
    `;
    card.appendChild(header);

    if (folder.error) {
      const err = document.createElement('p');
      err.className = 'error-msg';
      err.textContent = folder.error || 'Failed to load videos. Retrying...';
      card.appendChild(err);
      container.appendChild(card);
      return;
    }

    const tableHeader = document.createElement('div');
    tableHeader.className = 'table-header';
    tableHeader.innerHTML = '<span>Video Name</span><span>File Size</span>';
    card.appendChild(tableHeader);

    const body = document.createElement('div');
    body.className = 'table-body';
    const fragment = document.createDocumentFragment();
    folder.videos.forEach((video) => {
      const row = document.createElement('div');
      row.className = 'table-row';
      row.innerHTML = `
        <span class="truncate" title="${escapeHtml(video.title || video.original_file_name || '--')}">${escapeHtml(video.title || video.original_file_name || '--')}</span>
        <span>${escapeHtml(formatBytes(video.size))}</span>
      `;
      fragment.appendChild(row);
    });
    body.appendChild(fragment);
    card.appendChild(body);
    container.appendChild(card);
  });
}

function renderChannels() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '';
  const channels = state.data?.channels || [];
  const channelCountLabel = document.getElementById('channels-total-count');
  if (channelCountLabel) {
    channelCountLabel.textContent = `Total Channels: ${channels.length}`;
  }

  let highlightId = '';
  try {
    highlightId = localStorage.getItem('gda_channel_connected_id') || '';
  } catch (_) {}

  channels.forEach((channel) => {
    const card = document.createElement('div');
    card.className = 'channel-card';
    const channelName = channel.channel_name || channel.title || channel.label || 'Untitled Channel';
    const safeChannelName = escapeHtml(channelName);
    const channelUrl = channel.youtube_url || channel.channelUrl || '';
    const safeChannelUrl = escapeHtml(channelUrl);
    const avatarHtml = channel.thumbnail
      ? `<img src="${escapeHtml(channel.thumbnail)}" alt="${safeChannelName} logo" class="channel-avatar" />`
      : '<div class="channel-avatar inline-placeholder" aria-hidden="true">YT</div>';
    const channelUrlHtml = channelUrl ? `<p class="channel-url" title="${safeChannelUrl}">${safeChannelUrl}</p>` : '';

    const tokenConnected = channel.token_status === 'connected' || channel.status === 'connected';
    const reconnectRequired = Boolean(channel.reconnect_required);
    const statusClass = reconnectRequired ? 'reconnect' : (tokenConnected ? 'connected' : 'disconnected');
    const statusText = reconnectRequired ? 'Reconnect Required' : (tokenConnected ? 'Connected' : 'Disconnected');
    const tokenControlHtml = reconnectRequired
      ? '<button class="secondary" data-action="token">Reconnect</button>'
      : tokenConnected
        ? '<span class="status-connected"><span class="status-dot"></span>Connected</span>'
        : '<button class="secondary" data-action="token">Get Token</button>';
    const lastSync = formatShortDateTime(channel.last_sync_time);
    const tokenExpiry = formatShortDateTime(channel.token_expiry);

    card.innerHTML = `
      <div class="channel-main">
        <div class="channel-info">
          <input class="channel-check" type="checkbox" data-action="toggle-select" ${isChannelSelected(channel) ? 'checked' : ''} />
          ${avatarHtml}
          <div class="channel-text">
            <h4 class="channel-name" title="${safeChannelName}">${safeChannelName}</h4>
            ${channelUrlHtml}
            <div class="channel-meta">
              <span class="status-badge ${statusClass}"><span class="status-dot-sm"></span>${statusText}</span>
              <span class="short-path">Last Sync: ${escapeHtml(lastSync)}</span>
              <span class="short-path">Token Expiry: ${escapeHtml(tokenExpiry)}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="channel-actions">
        ${tokenControlHtml}
        <button class="secondary" data-action="open">Visit Channel</button>
        <button class="secondary remove-btn" data-action="delete" title="Remove Channel">Remove</button>
      </div>
    `;

    card.querySelector('[data-action="toggle-select"]').addEventListener('change', async (e) => {
      await window.api.setChannelSelected({ channelId: channel.id, selected: e.target.checked });
      await loadState();
    });
    const tokenBtn = card.querySelector('[data-action="token"]');
    if (tokenBtn) {
      tokenBtn.addEventListener('click', async () => {
        try {
          await window.api.getChannelToken(channel.id);
          await loadState();
        } catch (error) {
          addLog(`Token error for ${channelName}: ${error.message}`);
        }
      });
    }
    card.querySelector('[data-action="open"]').addEventListener('click', () => window.api.openChannel(channel.id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => window.api.deleteChannel(channel.id));

    list.appendChild(card);

    if (highlightId && highlightId === String(channel.id || '')) {
      card.classList.add('highlight');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      try {
        localStorage.removeItem('gda_channel_connected_id');
      } catch (_) {}
    }
  });
}

function renderDebugPanel() {
  const debug = state.data?.debug || {};
  const channelsEl = document.getElementById('debug-channels');
  const oauthEl = document.getElementById('debug-oauth');
  const errorEl = document.getElementById('debug-error');
  const logsEl = document.getElementById('debug-logs');
  if (!channelsEl || !oauthEl || !errorEl || !logsEl) return;

  channelsEl.textContent = JSON.stringify(debug.channels || [], null, 2);
  let oauthParams = {};
  try {
    oauthParams = JSON.parse(localStorage.getItem('gda_oauth_params') || '{}');
  } catch (_) {
    oauthParams = {};
  }
  oauthEl.textContent = JSON.stringify(oauthParams, null, 2);
  const lastError = Array.isArray(debug.errors) && debug.errors.length ? debug.errors[0] : '';
  errorEl.textContent = lastError ? JSON.stringify(lastError, null, 2) : '--';
  logsEl.textContent = JSON.stringify(debug.logs || [], null, 2);
}

function renderVideosPerDaySelector(current) {
  const container = document.getElementById('schedule-videos-box');
  if (!container) return;
  container.innerHTML = '';

  for (let i = 1; i <= 5; i += 1) {
    const div = document.createElement('div');
    div.className = 'box-item';
    if (i === current) div.classList.add('active');
    div.textContent = `${i} / day`;
    div.addEventListener('click', async () => {
      await window.api.setVideosPerDay(i);
      const hidden = document.getElementById('schedule-videos');
      if (hidden) hidden.value = String(i);
      await refreshAutomationStatus();
      renderStats();
      renderVideosPerDaySelector(i);
      adjustSlots(i);
      renderScheduleChannelList();
      renderSlots();
    });
    container.appendChild(div);
  }
}

function renderStats() {
  const channels = (state.data?.channels || []);
  const totalChannels = channels.length;
  const videos = state.data?.videos || [];
  const uploadedToday = videos.filter((video) => video.status === 'uploaded' && isUploadedToday(video)).length;
  const perChannelPerDay = Math.max(1, Math.min(5, Number(state.data?.settings?.videosPerDay || 1)));
  const totalPerDay = perChannelPerDay * Math.max(0, totalChannels);

  document.getElementById('stat-channels').textContent = String(totalChannels);
  document.getElementById('stat-videos-available').textContent = String(videos.length);
  document.getElementById('stat-videos-per-day').textContent = String(totalPerDay);
  const todayEl = document.getElementById('stat-today-uploaded');
  if (todayEl) todayEl.textContent = String(uploadedToday);
  renderChannelUploadTracker();
  renderAutomationTopSection();
}

function renderProgress() {
  // Progress bar intentionally removed for automation-first UX.
}

function syncUploadControls(automationEnabled, uploadRunning) {
  const startUploadBtn = document.getElementById('start-upload');
  const stopUploadBtn = document.getElementById('stop-upload');
  const startAutomationBtn = document.getElementById('start-automation');
  const stopAutomationBtn = document.getElementById('stop-automation');
  const uploadStrip = document.getElementById('upload-strip');

  if (startUploadBtn) startUploadBtn.classList.toggle('hidden', uploadRunning);
  if (stopUploadBtn) stopUploadBtn.classList.toggle('hidden', !uploadRunning);
  if (startAutomationBtn) startAutomationBtn.classList.toggle('hidden', automationEnabled);
  if (stopAutomationBtn) stopAutomationBtn.classList.toggle('hidden', !automationEnabled);
  if (uploadStrip) uploadStrip.classList.toggle('hidden', true);
}

async function refreshAutomationUpgradeStatus() {
  const statusEl = document.getElementById('cloud-upgrade-status');
  if (!statusEl) return;

  try {
    const status = await window.api.getAutomationUpgradeStatus();
    const value = (v) => (v ? 'Ready' : 'Missing');
    document.getElementById('upgrade-folders-ready').textContent = value(status.foldersReady);
    document.getElementById('upgrade-api-ready').textContent = value(status.apiModuleReady);
    document.getElementById('upgrade-workflow-ready').textContent = value(status.workflowReady);
    document.getElementById('upgrade-queue-count').textContent = String(status.queueCount || 0);

    statusEl.textContent = status.automationRunning ? 'Running' : status.overallReady ? 'Upgrade Ready' : 'Partial';
    statusEl.style.color = status.automationRunning ? 'var(--success)' : status.overallReady ? 'var(--accent-blue)' : 'var(--danger)';
  } catch (error) {
    statusEl.textContent = 'Unavailable';
    statusEl.style.color = 'var(--danger)';
  }
}

async function refreshInternet() {
  const ok = await window.api.checkInternet();
  const pill = document.getElementById('internet-status');
  if (!pill) return;
  pill.textContent = ok ? 'Online' : 'Offline';
  pill.style.color = ok ? 'var(--success)' : 'var(--danger)';
}

async function refreshAutomationStatus() {
  const status = await window.api.getAutomationStatus();
  const automationEnabled = Boolean(status.automationRunning);
  const uploadRunning = Boolean(status.uploadInProgress);
  state.automationStatus = {
    automationRunning: automationEnabled,
    uploadInProgress: uploadRunning,
  };
  document.getElementById('automation-running-text').textContent = status.automationRunning ? 'Yes' : 'No';
  const todayUploaded = (state.data?.videos || []).filter((video) => video.status === 'uploaded' && isUploadedToday(video)).length;
  document.getElementById('automation-pending-text').textContent = `Today Uploaded Videos: ${todayUploaded}`;
  document.getElementById('schedule-videos').value = String(status.videosPerDay || 5);
  syncUploadControls(automationEnabled, uploadRunning);
  renderProgress();
  renderVideosPerDaySelector(status.videosPerDay || 5);
  adjustSlots(status.videosPerDay || 5);
  renderScheduleChannelList();
  renderSlots();
  renderAutomationTopSection();
}

async function loadAppMeta() {
  try {
    state.appMeta = await window.api.getAppMeta();
  } catch (error) {
    state.appMeta = { version: '--' };
  }
  renderUpdateCard();
}

function adjustSlots(count) {
  const channels = getScheduleChannels();
  if (!state.channelSlotPlans || typeof state.channelSlotPlans !== 'object') {
    state.channelSlotPlans = {};
  }
  channels.forEach((channel) => {
    const channelId = channel._scheduleId;
    const current = normalizeSlotPlan(state.channelSlotPlans[channelId]);
    while (current.length < count) {
      current.push({
        time: '',
        date: '',
        publish_date: '',
        publish_time: '',
        upload_date: '',
        upload_time: '',
        auto_upload_enabled: true,
        videoId: '',
        title: '',
        status: 'pending',
        slot_number: current.length + 1,
        manualTime: false,
      });
    }
    if (current.length > count) {
      current.splice(count);
    }
    state.channelSlotPlans[channelId] = current.map((slot, index) => ({
      ...slot,
      slot_number: index + 1,
    }));
  });
  state.slots = normalizeSlotPlan(state.channelSlotPlans[state.selectedScheduleChannelId] || []);
}

function normalizeSlotPlan(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots.map((slot, index) => {
    const date = String(slot?.publish_date || slot?.date || '').trim();
    const time = String(slot?.publish_time || slot?.time || '').trim();
    const autoUploadEnabled = slot?.auto_upload_enabled !== undefined
      ? Boolean(slot.auto_upload_enabled)
      : !Boolean(slot?.manualTime || slot?.manual_upload_time);
    const uploadDate = String(slot?.upload_date || '').trim();
    const uploadTime = String(slot?.upload_time || '').trim();
    const normalized = {
      time,
      date,
      publish_date: date,
      publish_time: time,
      upload_date: uploadDate,
      upload_time: uploadTime,
      auto_upload_enabled: autoUploadEnabled,
      videoId: String(slot?.videoId || slot?.video_id || '').trim(),
      title: String(slot?.title || '').trim(),
      status: String(slot?.status || 'pending').trim() || 'pending',
      slot_number: Number(slot?.slot_number || (index + 1)),
      manualTime: !autoUploadEnabled,
    };
    if (normalized.auto_upload_enabled && normalized.date && normalized.time) {
      const auto = calculateAutoUploadFromPublish({
        publishDate: normalized.date,
        publishTime: normalized.time,
        slotNumber: normalized.slot_number,
      });
      normalized.upload_date = auto.upload_date;
      normalized.upload_time = auto.upload_time;
    }
    return normalized;
  });
}

function addMinutesToTime(baseTime, offsetMinutes) {
  const match = String(baseTime || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return '';
  const total = ((hh * 60) + mm + Number(offsetMinutes || 0)) % (24 * 60);
  const safeTotal = total < 0 ? total + (24 * 60) : total;
  const outH = Math.floor(safeTotal / 60);
  const outM = safeTotal % 60;
  return `${String(outH).padStart(2, '0')}:${String(outM).padStart(2, '0')}`;
}

function parseDateTimeLocal(dateStr, timeStr) {
  const date = String(dateStr || '').trim();
  const time = String(timeStr || '').trim();
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!date || !match) return null;
  const [y, m, d] = date.split('-').map(Number);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatDateOnlyLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTimeOnlyLocal(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function randomInt(min, max) {
  const lo = Math.ceil(Number(min || 0));
  const hi = Math.floor(Number(max || 0));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function to12HourParts(time24) {
  const match = String(time24 || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour12: '', minute: '', ampm: 'AM', label: '' };
  const hh = Number(match[1]);
  const mm = String(match[2]).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const hour12 = String(((hh + 11) % 12) + 1);
  const label = `${hour12.padStart(2, '0')}:${mm} ${ampm}`;
  return { hour12, minute: mm, ampm, label };
}

function from12HourParts(hour12, minute, ampm) {
  const h12Num = Number(hour12);
  const mmNum = Number(minute);
  if (!Number.isFinite(h12Num) || !Number.isFinite(mmNum)) return '';
  if (h12Num < 1 || h12Num > 12 || mmNum < 0 || mmNum > 59) return '';
  const h12 = Math.trunc(h12Num);
  const mm = Math.trunc(mmNum);
  const upper = String(ampm || 'AM').toUpperCase() === 'PM' ? 'PM' : 'AM';
  let h24 = h12 % 12;
  if (upper === 'PM') h24 += 12;
  return `${String(h24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function calculateAutoUploadFromPublish({ publishDate, publishTime, slotNumber }) {
  const publishAt = parseDateTimeLocal(publishDate, publishTime);
  if (!publishAt) {
    return { upload_date: '', upload_time: '' };
  }

  const windows = {
    1: { startDayOffset: -1, startHour: 15, endDayOffset: -1, endHour: 18 },
    2: { startDayOffset: -1, startHour: 19, endDayOffset: -1, endHour: 21 },
    3: { startDayOffset: -1, startHour: 22, endDayOffset: 0, endHour: 0 },
    4: { startDayOffset: 0, startHour: 1, endDayOffset: 0, endHour: 3 },
    5: { startDayOffset: 0, startHour: 4, endDayOffset: 0, endHour: 6 },
  };
  const safeSlot = Math.max(1, Math.min(5, Number(slotNumber || 1)));
  const cfg = windows[safeSlot] || windows[1];

  const publishMidnight = new Date(publishAt);
  publishMidnight.setHours(0, 0, 0, 0);

  const start = new Date(publishMidnight);
  start.setDate(start.getDate() + cfg.startDayOffset);
  start.setHours(cfg.startHour, 0, 0, 0);

  const end = new Date(publishMidnight);
  end.setDate(end.getDate() + cfg.endDayOffset);
  end.setHours(cfg.endHour, 0, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);

  const span = Math.max(1, end.getTime() - start.getTime());
  const candidate = new Date(start.getTime() + randomInt(0, span - 1));
  candidate.setSeconds(randomInt(3, 57), 0);

  if (candidate >= publishAt) {
    candidate.setTime(publishAt.getTime() - (2 * 60 * 60 * 1000));
  }

  return {
    upload_date: formatDateOnlyLocal(candidate),
    upload_time: formatTimeOnlyLocal(candidate),
  };
}

const FIXED_SLOT_TIMES = {
  1: { hour: 4, minute: 0 },
  2: { hour: 7, minute: 0 },
  3: { hour: 13, minute: 0 },
  4: { hour: 17, minute: 0 },
  5: { hour: 22, minute: 0 },
};

const SLOT_PRESETS_BY_COUNT = {
  1: [5],
  2: [1, 5],
  3: [1, 4, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
};

function getActiveSlotNumbersByCount(count) {
  const safe = Math.max(1, Math.min(5, Number(count || 1)));
  return SLOT_PRESETS_BY_COUNT[safe] ? SLOT_PRESETS_BY_COUNT[safe].slice() : SLOT_PRESETS_BY_COUNT[1].slice();
}

function validateSlotUploadTiming(slot) {
  const uploadAt = parseDateTimeLocal(slot.upload_date, slot.upload_time);
  const publishAt = parseDateTimeLocal(slot.date, slot.time);
  if (!uploadAt || !publishAt) return 'Invalid date/time.';
  if (uploadAt >= publishAt) return 'Upload must be before publish.';
  const gapHours = (publishAt.getTime() - uploadAt.getTime()) / (1000 * 60 * 60);
  if (gapHours < 2) return 'Minimum upload gap is 2 hours.';
  return '';
}

function isValidIsoDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && (dt.getMonth() + 1) === m && dt.getDate() === d;
}

function isValidTime24(value) {
  const time = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function parseIsoDateParts(value) {
  const date = String(value || '').trim();
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { dd: '', mm: '', yyyy: '' };
  return { dd: match[3], mm: match[2], yyyy: match[1] };
}

function buildIsoDateFromParts(dd, mm, yyyy) {
  const d = String(dd || '').trim();
  const m = String(mm || '').trim();
  const y = String(yyyy || '').trim();
  if (!d && !m && !y) return '';
  if (d.length !== 2 || m.length !== 2 || y.length !== 4) return '';
  const iso = `${y}-${m}-${d}`;
  return isValidIsoDate(iso) ? iso : '';
}

function sanitizeDigits(value, maxLen) {
  return String(value || '').replace(/\D+/g, '').slice(0, maxLen);
}

function padTwoIfSingle(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.length === 1 ? `0${raw}` : raw;
}

function isSlotFilled(slot) {
  return Boolean(
    slot?.date || slot?.time || slot?.upload_date || slot?.upload_time || slot?.videoId || slot?.title
  );
}

function getSlotBlockingError(slot) {
  if (!slot?.date || !slot?.time || !slot?.upload_date || !slot?.upload_time || !slot?.videoId || !slot?.title) {
    return 'All fields are required.';
  }
  if (!isValidIsoDate(slot.date) || !isValidIsoDate(slot.upload_date)) return 'Invalid date format.';
  if (!isValidTime24(slot.time) || !isValidTime24(slot.upload_time)) return 'Invalid time format.';
  return validateSlotUploadTiming(slot);
}

function flattenChannelSlotPlans() {
  const channels = getScheduleChannels();
  const combined = [];
  channels.forEach((channel) => {
    const channelId = channel._scheduleId;
    const channelName = getScheduleChannelName(channel);
    const plan = normalizeSlotPlan(state.channelSlotPlans[channelId] || []);
    plan.forEach((slot, index) => {
      combined.push({
        ...slot,
        publish_date: slot.date,
        publish_time: slot.time,
        slot_number: Number(slot.slot_number || (index + 1)),
        channelId,
        channelName,
      });
    });
  });
  return combined;
}

function renderScheduleChannelList() {
  const list = document.getElementById('schedule-channel-list');
  if (!list) return;
  list.innerHTML = '';

  const channels = getScheduleChannels();
  const activeChannel = ensureSelectedScheduleChannel();
  if (!channels.length) {
    list.innerHTML = '<p class="hint">No connected channels found.</p>';
    return;
  }

  channels.forEach((channel) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = getScheduleChannelName(channel);
    button.classList.toggle('active', channel._scheduleId === activeChannel?._scheduleId);
    button.addEventListener('click', () => {
      state.selectedScheduleChannelId = channel._scheduleId;
      state.slots = normalizeSlotPlan(state.channelSlotPlans[state.selectedScheduleChannelId] || []);
      renderScheduleChannelList();
      renderSlots();
    });
    list.appendChild(button);
  });
}

function renderAutoScheduleButton() {
  const btn = document.getElementById('auto-schedule-btn');
  if (!btn) return;
  btn.textContent = state.autoScheduleEnabled ? 'AUTO SCHEDULE: ON' : 'AUTO SCHEDULE: OFF';
  btn.classList.toggle('active', state.autoScheduleEnabled);
  const hasTitles = Array.isArray(state.data?.settings?.titlePool) && state.data.settings.titlePool.length > 0;
  const hasVideos = getDriveVideoPool().length > 0;
  btn.disabled = !(hasTitles && hasVideos);
  btn.title = btn.disabled ? 'Add titles and connect Drive videos first.' : '';
}

function renderSlots() {
  const container = document.getElementById('schedule-items');
  const title = document.getElementById('schedule-slots-title');
  if (!container) return;
  container.innerHTML = '';
  const channels = getScheduleChannels();
  const activeChannel = ensureSelectedScheduleChannel();
  if (!channels.length || !activeChannel) {
    if (title) title.textContent = 'Schedule Slots';
    container.innerHTML = '<p class="hint">Connect at least one channel to create channel-wise slots.</p>';
    return;
  }

  const activeChannelId = activeChannel._scheduleId;
  if (!state.channelSlotPlans || typeof state.channelSlotPlans !== 'object') {
    state.channelSlotPlans = {};
  }
  state.channelSlotPlans[activeChannelId] = normalizeSlotPlan(state.channelSlotPlans[activeChannelId] || []);
  state.slots = state.channelSlotPlans[activeChannelId];
  if (title) title.textContent = `Schedule Slots (${getScheduleChannelName(activeChannel)})`;

  const unassignedVideos = getDriveVideoPool();
  if (!state.slots.length) {
    container.innerHTML = '<p class="hint">No slots found. Choose videos/day and click AUTO SCHEDULE.</p>';
    return;
  }

  state.slots.forEach((slot, index) => {
    const card = document.createElement('div');
    const slotKey = `${activeChannelId}-${index}`;
    card.className = `slot-card ${state.selectedSlotKey === slotKey ? 'selected' : ''}`;
    const blockingError = isSlotFilled(slot) ? getSlotBlockingError(slot) : '';
    const uploadDateParts = parseIsoDateParts(slot.upload_date);
    const publishDateParts = parseIsoDateParts(slot.date);
    const upload12 = to12HourParts(slot.upload_time);
    const publish12 = to12HourParts(slot.time);

    card.innerHTML = `
      <div class="slot-header">Slot ${slot.slot_number || (index + 1)}</div>
      <div class="slot-section upload-section">
        <div class="slot-section-title">Upload (YouTube API Execution Time)</div>
        <div class="slot-fields compact-grid">
          <div class="slot-field">
            <label>Date</label>
            <div class="date-compact">
              <input type="text" inputmode="numeric" maxlength="2" class="slot-upload-dd" data-index="${index}" value="${uploadDateParts.dd}" placeholder="DD" />
              <input type="text" inputmode="numeric" maxlength="2" class="slot-upload-mm" data-index="${index}" value="${uploadDateParts.mm}" placeholder="MM" />
              <input type="text" inputmode="numeric" maxlength="4" class="slot-upload-yyyy" data-index="${index}" value="${uploadDateParts.yyyy}" placeholder="YYYY" />
            </div>
          </div>
          <div class="slot-field">
            <label>Time</label>
            <div class="time-compact-input">
              <input type="text" inputmode="numeric" maxlength="2" class="slot-upload-hh" data-index="${index}" value="${upload12.hour12}" placeholder="HH" />
              <span class="time-colon">:</span>
              <input type="text" inputmode="numeric" maxlength="2" class="slot-upload-min" data-index="${index}" value="${upload12.minute}" placeholder="MM" />
              <button type="button" class="slot-ampm slot-upload-ampm" data-index="${index}">${upload12.ampm || 'AM'}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="slot-section publish-section">
        <div class="slot-section-title">Publish (Live Time)</div>
        <div class="slot-fields compact-grid">
          <div class="slot-field">
            <label>Date</label>
            <div class="date-compact">
              <input type="text" inputmode="numeric" maxlength="2" class="slot-publish-dd" data-index="${index}" value="${publishDateParts.dd}" placeholder="DD" />
              <input type="text" inputmode="numeric" maxlength="2" class="slot-publish-mm" data-index="${index}" value="${publishDateParts.mm}" placeholder="MM" />
              <input type="text" inputmode="numeric" maxlength="4" class="slot-publish-yyyy" data-index="${index}" value="${publishDateParts.yyyy}" placeholder="YYYY" />
            </div>
          </div>
          <div class="slot-field">
            <label>Time</label>
            <div class="time-compact-input">
              <input type="text" inputmode="numeric" maxlength="2" class="slot-publish-hh" data-index="${index}" value="${publish12.hour12}" placeholder="HH" />
              <span class="time-colon">:</span>
              <input type="text" inputmode="numeric" maxlength="2" class="slot-publish-min" data-index="${index}" value="${publish12.minute}" placeholder="MM" />
              <button type="button" class="slot-ampm slot-publish-ampm" data-index="${index}">${publish12.ampm || 'AM'}</button>
            </div>
          </div>
        </div>
      </div>
      <div class="slot-fields compact-grid">
        <div class="slot-field">
          <label>Video</label>
          <select class="slot-video" data-index="${index}">
            <option value="">-- Select Video --</option>
            ${unassignedVideos.map(v => {
              const vid = v.id || v.drive_file_id || v.path;
              return `<option value="${vid}" ${slot.videoId === vid ? 'selected' : ''}>${escapeHtml(v.title || v.original_file_name || v.name)}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="slot-field">
          <label>Title</label>
          <input type="text" class="slot-title" data-index="${index}" value="${escapeHtml(slot.title || '')}" placeholder="Video Title" />
        </div>
      </div>
      <p class="error-msg slot-error ${blockingError ? '' : 'hidden'}">${escapeHtml(blockingError)}</p>
    `;

    card.addEventListener('click', () => {
      state.selectedSlotKey = slotKey;
      renderSlots();
    });

    const sanitizeFieldInput = (el, maxLen) => {
      el.value = sanitizeDigits(el.value, maxLen);
    };

    const padDateFields = (ddEl, mmEl, yyyyEl) => {
      ddEl.value = padTwoIfSingle(sanitizeDigits(ddEl.value, 2));
      mmEl.value = padTwoIfSingle(sanitizeDigits(mmEl.value, 2));
      yyyyEl.value = sanitizeDigits(yyyyEl.value, 4);
    };

    const padTimeFields = (hhEl, mmEl) => {
      hhEl.value = padTwoIfSingle(sanitizeDigits(hhEl.value, 2));
      mmEl.value = padTwoIfSingle(sanitizeDigits(mmEl.value, 2));
    };

    const setErrorText = (message) => {
      const errorEl = card.querySelector('.slot-error');
      errorEl.textContent = message || '';
      errorEl.classList.toggle('hidden', !message);
    };

    const toggleInvalid = (elements, invalid) => {
      elements.forEach((el) => el.classList.toggle('invalid', invalid));
    };

    const applyValidationUi = () => {
      const current = state.channelSlotPlans[activeChannelId][index];
      const hasUploadDate = Boolean(current.upload_date);
      const hasPublishDate = Boolean(current.date);
      const hasUploadTime = Boolean(current.upload_time);
      const hasPublishTime = Boolean(current.time);

      const uploadDateInvalid = hasUploadDate && !isValidIsoDate(current.upload_date);
      const publishDateInvalid = hasPublishDate && !isValidIsoDate(current.date);
      const uploadTimeInvalid = hasUploadTime && !isValidTime24(current.upload_time);
      const publishTimeInvalid = hasPublishTime && !isValidTime24(current.time);

      toggleInvalid(
        [
          card.querySelector('.slot-upload-dd'),
          card.querySelector('.slot-upload-mm'),
          card.querySelector('.slot-upload-yyyy'),
        ],
        uploadDateInvalid
      );
      toggleInvalid(
        [
          card.querySelector('.slot-publish-dd'),
          card.querySelector('.slot-publish-mm'),
          card.querySelector('.slot-publish-yyyy'),
        ],
        publishDateInvalid
      );
      toggleInvalid(
        [
          card.querySelector('.slot-upload-hh'),
          card.querySelector('.slot-upload-min'),
        ],
        uploadTimeInvalid
      );
      toggleInvalid(
        [
          card.querySelector('.slot-publish-hh'),
          card.querySelector('.slot-publish-min'),
        ],
        publishTimeInvalid
      );

      const message = isSlotFilled(current) ? getSlotBlockingError(current) : '';
      setErrorText(message);
    };

    const updatePublishDateFromParts = () => {
      const ddEl = card.querySelector('.slot-publish-dd');
      const mmEl = card.querySelector('.slot-publish-mm');
      const yyyyEl = card.querySelector('.slot-publish-yyyy');
      const iso = buildIsoDateFromParts(ddEl.value, mmEl.value, yyyyEl.value);
      state.channelSlotPlans[activeChannelId][index].date = iso;
      state.channelSlotPlans[activeChannelId][index].publish_date = iso;
      state.slots = state.channelSlotPlans[activeChannelId];
      applyValidationUi();
      scheduleAutomationSave();
    };

    const updatePublishTimeFromParts = () => {
      const hour = card.querySelector('.slot-publish-hh').value;
      const minute = card.querySelector('.slot-publish-min').value;
      const ampm = card.querySelector('.slot-publish-ampm').textContent;
      const value24 = from12HourParts(hour, minute, ampm);
      state.channelSlotPlans[activeChannelId][index].time = value24;
      state.channelSlotPlans[activeChannelId][index].publish_time = value24;
      state.slots = state.channelSlotPlans[activeChannelId];
      applyValidationUi();
      scheduleAutomationSave();
    };

    const updateUploadDateFromParts = () => {
      const ddEl = card.querySelector('.slot-upload-dd');
      const mmEl = card.querySelector('.slot-upload-mm');
      const yyyyEl = card.querySelector('.slot-upload-yyyy');
      const iso = buildIsoDateFromParts(ddEl.value, mmEl.value, yyyyEl.value);
      state.channelSlotPlans[activeChannelId][index].upload_date = iso;
      state.channelSlotPlans[activeChannelId][index].manual_upload_time = true;
      state.channelSlotPlans[activeChannelId][index].auto_upload_enabled = false;
      state.slots = state.channelSlotPlans[activeChannelId];
      applyValidationUi();
      scheduleAutomationSave();
    };

    const updateUploadTimeFromParts = () => {
      const hour = card.querySelector('.slot-upload-hh').value;
      const minute = card.querySelector('.slot-upload-min').value;
      const ampm = card.querySelector('.slot-upload-ampm').textContent;
      const value24 = from12HourParts(hour, minute, ampm);
      state.channelSlotPlans[activeChannelId][index].upload_time = value24;
      state.channelSlotPlans[activeChannelId][index].manual_upload_time = true;
      state.channelSlotPlans[activeChannelId][index].auto_upload_enabled = false;
      state.slots = state.channelSlotPlans[activeChannelId];
      applyValidationUi();
      scheduleAutomationSave();
    };

    const bindTypedDate = (ddSel, mmSel, yyyySel, onUpdate) => {
      const ddEl = card.querySelector(ddSel);
      const mmEl = card.querySelector(mmSel);
      const yyyyEl = card.querySelector(yyyySel);
      [ddEl, mmEl, yyyyEl].forEach((el) => {
        el.addEventListener('input', () => {
          sanitizeFieldInput(el, Number(el.maxLength || 2));
          onUpdate();
        });
      });
      [ddEl, mmEl, yyyyEl].forEach((el) => {
        el.addEventListener('blur', () => {
          padDateFields(ddEl, mmEl, yyyyEl);
          onUpdate();
        });
        el.addEventListener('keydown', (evt) => {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            el.blur();
          }
        });
      });
    };

    const bindTypedTime = (hhSel, mmSel, ampmSel, onUpdate) => {
      const hhEl = card.querySelector(hhSel);
      const mmEl = card.querySelector(mmSel);
      const ampmBtn = card.querySelector(ampmSel);
      [hhEl, mmEl].forEach((el) => {
        el.addEventListener('input', () => {
          sanitizeFieldInput(el, Number(el.maxLength || 2));
          onUpdate();
        });
        el.addEventListener('blur', () => {
          padTimeFields(hhEl, mmEl);
          onUpdate();
        });
        el.addEventListener('keydown', (evt) => {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            el.blur();
          }
        });
      });
      ampmBtn.addEventListener('click', () => {
        ampmBtn.textContent = ampmBtn.textContent === 'PM' ? 'AM' : 'PM';
        onUpdate();
      });
    };

    bindTypedDate('.slot-publish-dd', '.slot-publish-mm', '.slot-publish-yyyy', updatePublishDateFromParts);
    bindTypedDate('.slot-upload-dd', '.slot-upload-mm', '.slot-upload-yyyy', updateUploadDateFromParts);
    bindTypedTime('.slot-publish-hh', '.slot-publish-min', '.slot-publish-ampm', updatePublishTimeFromParts);
    bindTypedTime('.slot-upload-hh', '.slot-upload-min', '.slot-upload-ampm', updateUploadTimeFromParts);

    card.querySelector('.slot-video').addEventListener('change', e => { 
      state.channelSlotPlans[activeChannelId][index].videoId = e.target.value;
      const vid = unassignedVideos.find(v => (v.id || v.drive_file_id || v.path) === e.target.value);
      if (vid && !state.channelSlotPlans[activeChannelId][index].title) {
        state.channelSlotPlans[activeChannelId][index].title = vid.title || vid.original_file_name || '';
        card.querySelector('.slot-title').value = state.channelSlotPlans[activeChannelId][index].title;
      }
      state.slots = state.channelSlotPlans[activeChannelId];
      applyValidationUi();
      scheduleAutomationSave();
    });
    card.querySelector('.slot-title').addEventListener('input', e => {
      state.channelSlotPlans[activeChannelId][index].title = e.target.value;
      state.slots = state.channelSlotPlans[activeChannelId];
      applyValidationUi();
      scheduleAutomationSave();
    });
    applyValidationUi();
    container.appendChild(card);
  });
}

document.getElementById('auto-schedule-btn')?.addEventListener('click', () => {
  const channels = getScheduleChannels().filter(isChannelSelected);
  if (!channels.length) {
    addLog('Auto Schedule blocked: connect at least one selected channel.');
    return;
  }

  const perChannelCount = Math.max(1, Math.min(5, Number(state.data?.settings?.videosPerDay || 1)));
  if (!perChannelCount) {
    addLog('Auto Schedule blocked: choose videos/day first.');
    return;
  }

  const baseTitlePool = Array.isArray(state.data?.settings?.titlePool)
    ? [...state.data.settings.titlePool]
    : String(state.data?.settings?.titlePool || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  if (!baseTitlePool.length) {
    addLog('Auto Schedule blocked: add titles in Content Settings first.');
    return;
  }

  const unassigned = getDriveVideoPool();
  if (!unassigned.length) {
    addLog('Auto Schedule blocked: no Google Drive videos found.');
    return;
  }

  state.autoScheduleEnabled = true;
  renderAutoScheduleButton();

  const activeSlotNumbers = getActiveSlotNumbersByCount(perChannelCount);
  const shuffledChannels = [...channels].sort(() => Math.random() - 0.5);
  let videoCursor = 0;
  let titleCursor = 0;
  const usedPublishTimes = new Set();
  const usedUploadTimes = new Set();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const uploadWindowForSlot = (publishBase, slotNumber) => {
    const windows = {
      1: { startDayOffset: -1, startHour: 15, endDayOffset: -1, endHour: 18 },
      2: { startDayOffset: -1, startHour: 19, endDayOffset: -1, endHour: 21 },
      3: { startDayOffset: -1, startHour: 22, endDayOffset: 0, endHour: 0 },
      4: { startDayOffset: 0, startHour: 1, endDayOffset: 0, endHour: 3 },
      5: { startDayOffset: 0, startHour: 4, endDayOffset: 0, endHour: 6 },
    };
    const cfg = windows[slotNumber] || windows[1];
    const start = new Date(publishBase);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + cfg.startDayOffset);
    start.setHours(cfg.startHour, 0, 0, 0);
    const end = new Date(publishBase);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + cfg.endDayOffset);
    end.setHours(cfg.endHour, 0, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);
    return { start, end };
  };

  const plans = {};
  shuffledChannels.forEach((channel) => {
    plans[channel._scheduleId] = [];
  });

  activeSlotNumbers.forEach((slotNumber) => {
    const basePublish = new Date(tomorrow);
    const fixed = FIXED_SLOT_TIMES[slotNumber] || FIXED_SLOT_TIMES[5];
    basePublish.setHours(fixed.hour, fixed.minute, 0, 0);

    const channelOrder = [...shuffledChannels].sort(() => Math.random() - 0.5);
    const { start, end } = uploadWindowForSlot(basePublish, slotNumber);
    const spanMs = Math.max(1, end.getTime() - start.getTime());
    const stepMs = spanMs / (channelOrder.length + 1);
    let cumulativePublishDelay = 0;

    channelOrder.forEach((channel, index) => {
      if (index > 0) cumulativePublishDelay += randomInt(1, 5);
      const channelId = channel._scheduleId;
      const slot = {
        slot_number: slotNumber,
        date: '',
        time: '',
        publish_date: '',
        publish_time: '',
        upload_date: '',
        upload_time: '',
        auto_upload_enabled: true,
        manual_upload_time: false,
        videoId: '',
        title: '',
        status: 'scheduled',
      };

      const publishAt = new Date(basePublish);
      publishAt.setMinutes(publishAt.getMinutes() + cumulativePublishDelay);
      publishAt.setSeconds(randomInt(1, 50), 0);
      while (usedPublishTimes.has(`${formatDateOnlyLocal(publishAt)} ${formatTimeOnlyLocal(publishAt)}`)) {
        publishAt.setMinutes(publishAt.getMinutes() + 1);
      }
      usedPublishTimes.add(`${formatDateOnlyLocal(publishAt)} ${formatTimeOnlyLocal(publishAt)}`);
      slot.date = formatDateOnlyLocal(publishAt);
      slot.publish_date = slot.date;
      slot.time = formatTimeOnlyLocal(publishAt);
      slot.publish_time = slot.time;

      const anchorMs = start.getTime() + (stepMs * (index + 1));
      const jitterMs = randomInt(-Math.floor(stepMs * 0.35), Math.floor(stepMs * 0.35));
      const uploadAt = new Date(Math.max(start.getTime() + 60_000, Math.min(end.getTime() - 60_000, anchorMs + jitterMs)));
      uploadAt.setSeconds(randomInt(3, 57), 0);
      while (usedUploadTimes.has(`${formatDateOnlyLocal(uploadAt)} ${formatTimeOnlyLocal(uploadAt)}`)) {
        uploadAt.setMinutes(uploadAt.getMinutes() + 1);
      }
      if (uploadAt >= publishAt) {
        uploadAt.setTime(publishAt.getTime() - (2 * 60 * 60 * 1000));
      }
      usedUploadTimes.add(`${formatDateOnlyLocal(uploadAt)} ${formatTimeOnlyLocal(uploadAt)}`);
      slot.upload_date = formatDateOnlyLocal(uploadAt);
      slot.upload_time = formatTimeOnlyLocal(uploadAt);

      if (videoCursor < unassigned.length) {
        const vid = unassigned[videoCursor++];
        slot.videoId = vid.id || vid.drive_file_id || vid.path;
        slot.title = vid.title || vid.original_file_name || '';
      }

      slot.title = baseTitlePool[titleCursor % baseTitlePool.length];
      titleCursor += 1;

      plans[channelId].push(slot);
    });
  });

  channels.forEach((channel) => {
    const channelId = channel._scheduleId;
    const plan = (plans[channelId] || []).sort((a, b) => a.slot_number - b.slot_number);
    state.channelSlotPlans[channelId] = normalizeSlotPlan(plan);
  });

  state.slots = normalizeSlotPlan(state.channelSlotPlans[state.selectedScheduleChannelId] || []);
  renderScheduleChannelList();
  renderSlots();
  addLog('Auto Schedule: fixed publish slots + randomized upload windows applied for all active channels.');
  scheduleAutomationSave();
  const totalRequired = perChannelCount * channels.length;
  if (unassigned.length < totalRequired) {
     addLog(`WARNING: Only ${unassigned.length} videos available for ${totalRequired} channel slots.`);
  }
});

document.getElementById('save-plan-btn')?.addEventListener('click', async () => {
  try {
    const flattened = flattenChannelSlotPlans();
    const blockingSlot = flattened.find((slot) => getSlotBlockingError(slot));
    if (blockingSlot) {
      addLog(`Save plan blocked: ${blockingSlot.channelName} Slot ${blockingSlot.slot_number} -> ${getSlotBlockingError(blockingSlot)}`);
      return;
    }
    const automationSlots = Array.from(new Set(
      flattened.map((slot) => slot.upload_time).filter(Boolean)
    )).sort();
    await window.api.saveAutomationSettings({
      auto_schedule_enabled: state.autoScheduleEnabled,
      channel_slot_plans: state.channelSlotPlans,
      slots: flattened,
      automation_slots: automationSlots,
    });
    state.slots = normalizeSlotPlan(state.channelSlotPlans[state.selectedScheduleChannelId] || []);
    addLog('Slot plan saved successfully.');
    setAutosaveStatus('Saved');
  } catch (err) {
    addLog(`Error saving plan: ${err.message}`);
  }
});

async function refreshUpdateStatus() {
  try {
    state.updater = await window.api.getUpdateStatus();
  } catch (error) {
    state.updater = {
      stage: 'error',
      message: error.message || 'Unable to load updater status.',
      currentVersion: state.appMeta?.version || '--',
    };
  }
  renderUpdateCard();
}

async function fetchDriveVideos(options = {}) {
  const { silent = false } = options;
  if (!state.driveAuth?.connected) {
    if (!silent) setDriveFolderImportResult('Connect Google Drive first.', true);
    return;
  }
  await loadConnectedDriveFolders();
  let links = Array.from(new Set([...(state.driveFolders || [])]))
    .filter((link) => extractDriveFolderId(link));
  if (!links.length) {
    if (!silent) setDriveFolderImportResult('Connect a Google Drive folder first.', true);
    return;
  }

  state.driveFolders = links;
  await window.api.updateSettings({ driveFolderLinks: links });

  if (!silent) setDriveFolderImportLoading(true);
  if (!silent) setDriveFolderImportResult('');

  try {
    const results = await Promise.allSettled(
      links.map((folderLink) => window.api.fetchDriveVideos({ folderLink }))
    );

    const nextData = {};
    results.forEach((result, index) => {
      const folderLink = links[index];
      const folderId = extractDriveFolderId(folderLink);
      if (!folderId) return;
      if (result.status === 'fulfilled') {
        nextData[folderId] = {
          videos: Array.isArray(result.value?.videos) ? result.value.videos : [],
          error: '',
        };
      } else {
        nextData[folderId] = {
          videos: [],
          error: result.reason?.message || 'Failed',
        };
      }
    });

    state.driveFolderData = nextData;
    renderVideos();
    const total = Object.values(nextData).reduce((acc, item) => acc + (item.videos?.length || 0), 0);
    const summary = `Total Videos: ${total}`;
    if (!silent) setDriveFolderImportResult(summary);
  } catch (error) {
    if (!silent) setDriveFolderImportResult(error.message || 'Drive fetch failed', true);
  } finally {
    if (!silent) setDriveFolderImportLoading(false);
  }
}

async function loadState() {
  state.data = await window.api.getState();
  state.autoScheduleEnabled = Boolean(state.data?.settings?.autoScheduleEnabled);
  const channels = getScheduleChannels();
  const fromChannelPlans = state.data?.settings?.channelSlotPlans;
  state.channelSlotPlans = {};

  if (fromChannelPlans && typeof fromChannelPlans === 'object') {
    channels.forEach((channel) => {
      const channelId = channel._scheduleId;
      state.channelSlotPlans[channelId] = normalizeSlotPlan(fromChannelPlans[channelId] || []);
    });
  } else {
    const fromSettingsSlots = normalizeSlotPlan(state.data?.settings?.slots);
    if (channels.length && fromSettingsSlots.length) {
      state.channelSlotPlans[channels[0]._scheduleId] = fromSettingsSlots;
    }
  }

  const videosPerDay = Number(state.data?.settings?.videosPerDay || 5);
  ensureSelectedScheduleChannel();
  adjustSlots(videosPerDay);
  state.slots = normalizeSlotPlan(state.channelSlotPlans[state.selectedScheduleChannelId] || []);

  const configuredLinks = Array.isArray(state.data?.settings?.driveFolderLinks) ? state.data.settings.driveFolderLinks : [];
  if (!Array.isArray(state.driveFolders) || !state.driveFolders.length) {
    state.driveFolders = configuredLinks;
  }
  if (!state.driveFolderData || typeof state.driveFolderData !== 'object') {
    state.driveFolderData = {};
  }
  if (!Array.isArray(state.tagChips) || state.tagChips.length === 0) {
    state.tagChips = parseTagsFromString(state.data?.settings?.globalTags || '');
  }
  const titlesInput = document.getElementById('global-titles-input');
  if (titlesInput) {
    const titles = Array.isArray(state.data?.settings?.titlePool) ? state.data.settings.titlePool : [];
    titlesInput.value = titles.join('\n');
  }
  const descriptionInput = document.getElementById('global-description-input');
  if (descriptionInput) {
    descriptionInput.value = String(state.data?.settings?.globalDescription || '');
  }
  await refreshDriveAuthStatus();
  await loadConnectedDriveFolders();
  renderVideos();
  renderChannels();
  captureUploadedEvents(state.data);
  renderStats();
  renderDebugPanel();
  renderAutoScheduleButton();
  renderScheduleChannelList();
  renderSlots();
  renderProgress();
  await refreshAutomationStatus();
  await refreshAutomationUpgradeStatus();

  try {
    if (localStorage.getItem('gda_channel_connected') === '1') {
      localStorage.removeItem('gda_channel_connected');
      showChannelToast('Channel Connected Successfully', 'success');
    }
  } catch (_) {}
}

window.api.onLog((message) => addLog(message));
window.api.onProgress((payload) => {
  state.uploadSummary.totalVideos = Number(payload.totalVideos || 0);
  state.uploadSummary.completedVideos = Number(payload.completedVideos || 0);
  state.uploadSummary.totalBytes = Number(payload.totalBytes || 0);
  state.uploadSummary.uploadedBytes = Number(payload.uploadedBytes || 0);
  renderProgress();
});
window.api.onDriveSyncProgress((payload) => {
  const statusEl = document.getElementById('drive-upload-status');
  const progressBar = document.getElementById('drive-upload-progress');
  if (!statusEl) return;
  const total = Number(payload?.total || 0);
  const done = Number(payload?.done || 0);
  const uploaded = Number(payload?.uploaded || 0);
  const failed = Number(payload?.failed || 0);
  const message = payload?.message || '';
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  if (progressBar) {
    progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  if (total > 0) {
    statusEl.textContent = `${message} (${done}/${total}, success ${uploaded}, failed ${failed})`;
  } else {
    statusEl.textContent = message || 'Upload progress will appear here.';
  }
});
window.api.onDriveUploadItem((payload) => {
  const feed = document.getElementById('drive-upload-feed');
  if (!feed) return;

  const fileName = String(payload?.fileName || 'Uploaded file');
  const visitLink = String(payload?.visitLink || '').trim();

  const row = document.createElement('div');
  row.className = 'table-row';
  row.style.gridTemplateColumns = '1fr auto';
  row.innerHTML = `
    <span class="truncate" title="${escapeHtml(fileName)}">Uploaded: ${escapeHtml(fileName)}</span>
    <button class="secondary" data-action="visit-file">Visit File</button>
  `;
  row.querySelector('[data-action="visit-file"]')?.addEventListener('click', async () => {
    if (!visitLink) return;
    await window.api.openExternal(visitLink);
  });
  feed.prepend(row);
});
window.api.onState((data) => {
  captureUploadedEvents(data);
  state.data = data;
  state.autoScheduleEnabled = Boolean(state.data?.settings?.autoScheduleEnabled);
  const fromChannelPlans = state.data?.settings?.channelSlotPlans;
  if (fromChannelPlans && typeof fromChannelPlans === 'object') {
    const channels = getScheduleChannels();
    state.channelSlotPlans = {};
    channels.forEach((channel) => {
      state.channelSlotPlans[channel._scheduleId] = normalizeSlotPlan(fromChannelPlans[channel._scheduleId] || []);
    });
  }
  ensureSelectedScheduleChannel();
  adjustSlots(Number(state.data?.settings?.videosPerDay || 5));
  renderVideos();
  renderChannels();
  renderAutoScheduleButton();
  renderScheduleChannelList();
  renderSlots();
  renderStats();
  renderDebugPanel();
  refreshAutomationStatus();
  refreshAutomationUpgradeStatus();
  if (isLibraryPageActive()) {
    fetchDriveVideos({ silent: true });
  }
});

function setDriveFolderImportLoading(loading) {
  const loadingEl = document.getElementById('drive-folder-loading');
  const importBtn = document.getElementById('import-drive-folder');
  const refreshBtn = document.getElementById('refresh-drive-folder');
  if (loadingEl) loadingEl.classList.toggle('hidden', !loading);
  if (importBtn) importBtn.disabled = loading;
  if (refreshBtn) refreshBtn.disabled = loading;
}

function setDriveFolderImportResult(message, isError = false) {
  const errorEl = document.getElementById('drive-folder-error');
  if (errorEl) {
    errorEl.textContent = isError ? message : '';
  }
  if (!isError) {
    const counterEl = document.getElementById('drive-folder-counter');
    if (counterEl && message) {
      counterEl.textContent = message;
    }
  }
}

document.getElementById('import-drive-folder')?.addEventListener('click', async () => {
  const select = document.getElementById('drive-folder-select');
  const folderId = String(select?.value || '').trim();
  const folder = (state.driveFolderOptions || []).find((item) => String(item?.id || '') === folderId);
  if (!folder) {
    setDriveFolderImportResult('Select a Google Drive folder first.', true);
    return;
  }
  setDriveFolderImportResult('');
  try {
    await window.api.connectDriveFolder({
      folderId: folder.id,
      folderName: folder.name,
      folderLink: folder.link,
    });
    const linkInput = document.getElementById('drive-folder-link-input');
    if (linkInput) linkInput.value = folder.link || '';
    const next = Array.from(new Set([...(state.driveFolders || []), folder.link].filter(Boolean)));
    state.driveFolders = next;
    await window.api.updateSettings({ driveFolderLinks: next });
    const selectedLabel = document.getElementById('drive-folder-selected');
    if (selectedLabel) {
      const names = next
        .map((link) => {
          const match = (state.driveFolderOptions || []).find((item) => String(item?.link || '') === link);
          return match?.name || link || 'Drive Folder';
        })
        .filter(Boolean);
      selectedLabel.textContent = `Selected folders: ${names.join(', ')}`;
    }
  } catch (error) {
    setDriveFolderImportResult(error.message || 'Failed to connect Drive folder', true);
    return;
  }
  await fetchDriveVideos();
});

document.getElementById('refresh-drive-folder')?.addEventListener('click', async () => {
  await refreshDriveFolderOptions();
  await fetchDriveVideos();
});

document.getElementById('drive-auth-connect')?.addEventListener('click', async () => {
  setDriveFolderImportResult('');
  try {
    const response = await window.api.startDriveAuth();
    const authUrl = response?.auth_url;
    if (!authUrl) {
      throw new Error('Drive auth URL missing.');
    }
    const popup = window.open(authUrl, 'driveAuth', 'width=520,height=680');
    if (!popup) {
      setDriveFolderImportResult('Popup blocked. Please allow popups and try again.', true);
    }
  } catch (error) {
    setDriveFolderImportResult(error.message || 'Drive sign-in failed', true);
  }
});

document.getElementById('drive-auth-check')?.addEventListener('click', async () => {
  await refreshDriveAuthStatus();
  await refreshDriveFolderOptions();
});

window.addEventListener('message', async (event) => {
  if (event?.data?.type === 'drive-auth-success') {
    await refreshDriveAuthStatus();
    await refreshDriveFolderOptions();
  }
});

document.getElementById('tags-entry-input')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const raw = String(event.target.value || '').trim();
  if (!raw) return;
  if (!state.tagChips.includes(raw)) {
    state.tagChips.push(raw);
  }
  event.target.value = '';
  renderTagChips();
});

async function startDriveUpload(localPaths) {
  const errorEl = document.getElementById('drive-upload-error');
  const statusEl = document.getElementById('drive-upload-status');
  if (errorEl) errorEl.textContent = '';
  if (statusEl) statusEl.textContent = 'Preparing upload...';
  const folderLink = document.getElementById('drive-folder-link-input')?.value?.trim() || state.driveFolders[0] || '';

  try {
    const result = await window.api.uploadVideosToDrive({
      paths: localPaths,
      folderLink,
    });
    if (statusEl) {
      statusEl.textContent = `Upload complete. Uploaded ${result.uploaded || 0}, failed ${result.failed || 0}.`;
    }
    await fetchDriveVideos({ silent: true });
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message || 'Drive upload failed';
  }
}

function extractLocalPathsFromFileList(fileList) {
  const files = Array.from(fileList || []);
  return files
    .map((file) => String(file?.path || '').trim())
    .filter(Boolean);
}

const dropZone = document.getElementById('drive-drop-zone');
if (dropZone) {
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add('active');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove('active');
    });
  });

  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const paths = extractLocalPathsFromFileList(event.dataTransfer?.files || []);
    if (!paths.length) return;
    await startDriveUpload(paths);
  });
}

document.getElementById('pick-drive-files')?.addEventListener('click', () => {
  document.getElementById('drive-file-picker')?.click();
});

document.getElementById('pick-drive-folder')?.addEventListener('click', () => {
  document.getElementById('drive-folder-picker')?.click();
});

document.getElementById('drive-file-picker')?.addEventListener('change', async (event) => {
  const paths = extractLocalPathsFromFileList(event.target?.files || []);
  if (paths.length) {
    await startDriveUpload(paths);
  }
  event.target.value = '';
});

document.getElementById('drive-folder-picker')?.addEventListener('change', async (event) => {
  const paths = extractLocalPathsFromFileList(event.target?.files || []);
  if (paths.length) {
    await startDriveUpload(paths);
  }
  event.target.value = '';
});

document.getElementById('save-content-settings')?.addEventListener('click', async () => {
  const titlesEl = document.getElementById('global-titles-input');
  const titlesErrorEl = document.getElementById('titles-error');
  const metadataErrorEl = document.getElementById('metadata-error');
  const titles = parseTitleLines(titlesEl?.value || '');
  if (titlesErrorEl) titlesErrorEl.textContent = '';
  if (metadataErrorEl) metadataErrorEl.textContent = '';

  if (!titles.length) {
    if (titlesErrorEl) titlesErrorEl.textContent = 'Add at least one title.';
    return;
  }

  const tags = state.tagChips.join(', ');
  const description = document.getElementById('global-description-input')?.value?.trim() || '';

  try {
    await window.api.saveContentSettings({
      titles,
      description,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    await window.api.autoAssignVideoTitles(titles);
    await window.api.applyGlobalMetadataToVideos();
    await loadState();
    addLog(`Content settings saved (${titles.length} titles, ${state.tagChips.length} tags).`);
  } catch (error) {
    if (metadataErrorEl) metadataErrorEl.textContent = error.message || 'Failed to save content settings';
  }
});

document.getElementById('save-api-keys')?.addEventListener('click', async () => {
  const driveKey = document.getElementById('drive-api-key-input')?.value?.trim() || '';
  const youtubeKey = document.getElementById('youtube-api-key-input')?.value?.trim() || '';
  const errorEl = document.getElementById('api-key-error');
  if (errorEl) errorEl.textContent = '';

  if (!driveKey) {
    if (errorEl) errorEl.textContent = 'Drive API Key is required.';
    return;
  }

  try {
    await window.api.updateSettings({
      driveApiKey: driveKey,
      youtubeApiKey: youtubeKey,
    });
    document.getElementById('drive-api-key-input').value = '';
    document.getElementById('youtube-api-key-input').value = '';
    await loadState();
    addLog('API keys saved. Drive import will use DRIVE_API_KEY only.');
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message || 'Failed to save API keys';
  }
});

document.getElementById('clear-videos')?.addEventListener('click', async () => {
  const confirmed = window.confirm('Delete ALL videos from Google Drive folder and clear the app list?');
  if (!confirmed) return;

  const errorEl = document.getElementById('drive-upload-error');
  if (errorEl) errorEl.textContent = '';
  try {
    const folderLink = document.getElementById('drive-folder-link-input')?.value?.trim() || '';
    await window.api.deleteAllDriveVideos({ folderLink });
    await fetchDriveVideos({ silent: true });
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message || 'Failed to delete all videos';
  }
});

document.getElementById('start-upload')?.addEventListener('click', async () => {
  addLog('Starting manual upload cycle...');
  syncUploadControls(state.automationStatus.automationRunning, true);
  state.uploadSummary.totalVideos = 0;
  state.uploadSummary.completedVideos = 0;
  state.automationStatus.uploadInProgress = true;
  renderProgress();
  try {
    const result = await window.api.startUpload();
    if (result?.status === 'busy') {
      addLog(result.message || 'Upload already running.');
    }
    await loadState();
  } catch (error) {
    addLog(`Upload error: ${error.message}`);
  }
});

document.getElementById('stop-upload')?.addEventListener('click', async () => {
  addLog('Stopping upload cycle...');
  try {
    await window.api.stopUpload();
    await loadState();
  } catch (error) {
    addLog(`Stop error: ${error.message}`);
  }
});

document.getElementById('refresh-channels')?.addEventListener('click', async () => {
  addLog('Refreshing channels...');
  await loadState();
});

document.getElementById('start-automation')?.addEventListener('click', async () => {
  const now = new Date().toISOString();
  if (state.data?.settings) {
    state.data.settings.automationStartedAt = now;
    state.data.settings.automationStoppedAt = '';
    state.data.settings.automationRunning = true;
  }
  renderAutomationTopSection();
  try {
    const normalized = flattenChannelSlotPlans();
    const blockingSlot = normalized.find((slot) => getSlotBlockingError(slot));
    if (blockingSlot) {
      addLog(`Start blocked: ${blockingSlot.channelName} Slot ${blockingSlot.slot_number} -> ${getSlotBlockingError(blockingSlot)}`);
      return;
    }
    const automationSlots = Array.from(new Set(
      normalized.map((slot) => slot.upload_time).filter(Boolean)
    )).sort();
    await window.api.saveAutomationSettings({
      auto_schedule_enabled: state.autoScheduleEnabled,
      channel_slot_plans: state.channelSlotPlans,
      slots: normalized,
      automation_slots: automationSlots,
    });
    state.slots = normalizeSlotPlan(state.channelSlotPlans[state.selectedScheduleChannelId] || []);

    const preflight = await window.api.preflightAutomation();
    if (!preflight?.ok) {
      const reasons = Array.isArray(preflight?.errors) ? preflight.errors : ['Preflight validation failed.'];
      reasons.forEach((reason) => addLog(`Preflight: ${reason}`));
      return;
    }

    await window.api.startAutomation();
    await loadState();
  } catch (error) {
    if (state.data?.settings) {
      state.data.settings.automationRunning = false;
    }
    renderAutomationTopSection();
    addLog(`? Automation error: ${error.message}`);
    await loadState();
  }
});

document.getElementById('stop-automation')?.addEventListener('click', async () => {
  const now = new Date().toISOString();
  if (state.data?.settings) {
    state.data.settings.automationRunning = false;
    state.data.settings.automationStoppedAt = now;
  }
  renderAutomationTopSection();
  try {
    await window.api.stopAutomation();
    await loadState();
  } catch (error) {
    addLog(`? Automation stop error: ${error.message}`);
  }
});

document.getElementById('check-update-btn')?.addEventListener('click', async () => {
  try {
    addLog('Checking for app updates...');
    await window.api.checkForUpdates();
    await refreshUpdateStatus();
  } catch (error) {
    addLog(`Update check failed: ${error.message}`);
    state.updater = {
      ...(state.updater || {}),
      stage: 'error',
      message: error.message || 'Update check failed.',
    };
    renderUpdateCard();
  }
});

document.getElementById('install-update-btn')?.addEventListener('click', async () => {
  try {
    addLog('Installing downloaded update and restarting app...');
    await window.api.installDownloadedUpdate();
  } catch (error) {
    addLog(`Install update failed: ${error.message}`);
    state.updater = {
      ...(state.updater || {}),
      stage: 'error',
      message: error.message || 'Install update failed.',
    };
    renderUpdateCard();
  }
});

// Channels
const addChannelBtn = document.getElementById('add-channel');
const channelModal = document.getElementById('channel-modal');
const connectOverlay = document.getElementById('connect-loading-overlay');
const channelToast = document.getElementById('channel-toast');
let channelConnectInProgress = false;
let channelToastTimer = null;
let oauthJsonValidationError = '';

function setChannelFormMessage(message, type = 'error') {
  const errorEl = document.getElementById('channel-form-error');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.classList.toggle('success-msg', type === 'success');
}

function showChannelToast(message, type = 'success') {
  if (!channelToast) return;
  channelToast.textContent = message;
  channelToast.classList.remove('hidden', 'success', 'error');
  channelToast.classList.add(type === 'success' ? 'success' : 'error');
  if (channelToastTimer) clearTimeout(channelToastTimer);
  channelToastTimer = setTimeout(() => {
    channelToast.classList.add('hidden');
  }, 3000);
}

function setChannelLoading(loading) {
  document.body.classList.toggle('app-loading', loading);
  connectOverlay?.classList.toggle('hidden', !loading);
}

function mapChannelConnectError(error) {
  const raw = String(error?.message || '').trim();
  const message = raw.toLowerCase();

  if (message === '__channel_connect_timeout__') {
    return 'Connection Timeout. Please try again.';
  }
  if (message.includes('invalid_client') || message.includes('invalid client') || message.includes('client id')) {
    return 'Invalid Client ID';
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

function resetChannelForm() {
  document.getElementById('client-id').value = '';
  document.getElementById('client-secret').value = '';
  document.getElementById('api-key').value = '';
  document.getElementById('channel-url').value = '';
  document.getElementById('oauth-json').value = '';
  document.getElementById('oauth-json-text').value = '';
  document.getElementById('oauth-file-name').textContent = '';
  oauthJsonValidationError = '';
  setChannelFormMessage('');
}

const scheduleAutomationSave = debounce(async () => {
  try {
    const flattened = flattenChannelSlotPlans();
    const automationSlots = Array.from(new Set(
      flattened.map((slot) => slot.upload_time).filter(Boolean),
    )).sort();
    await window.api.saveAutomationSettings({
      auto_schedule_enabled: state.autoScheduleEnabled,
      channel_slot_plans: state.channelSlotPlans,
      slots: flattened,
      automation_slots: automationSlots,
    });
    setAutosaveStatus('Saved');
  } catch (error) {
    addLog(`Auto save failed: ${error.message || error}`);
  }
}, 400);

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function setAutosaveStatus(message) {
  const el = document.getElementById('autosave-status');
  if (!el) return;
  el.textContent = message;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 1200);
}

function getDriveVideoPool() {
  const buckets = Object.values(state.driveFolderData || {});
  const all = buckets.flatMap((bucket) => Array.isArray(bucket?.videos) ? bucket.videos : []);
  const unique = new Map();
  all.forEach((video) => {
    const key = video.id || video.drive_file_id || video.drive_link || video.title;
    if (!key) return;
    if (!unique.has(key)) unique.set(key, video);
  });
  return Array.from(unique.values());
}

addChannelBtn.addEventListener('click', () => {
  resetChannelForm();
  channelModal.classList.remove('hidden');
});

document.getElementById('close-modal')?.addEventListener('click', () => {
  if (channelConnectInProgress) return;
  channelModal.classList.add('hidden');
});

function parseGoogleOAuthJson(input) {
  let parsed;
  try {
    parsed = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    throw new Error('Invalid JSON format.');
  }
  const source = parsed?.web || parsed?.installed;
  if (!source || typeof source !== 'object') {
    throw new Error('Invalid OAuth JSON: expected "web" or "installed" object.');
  }
  const clientId = String(source.client_id || '').trim();
  const clientSecret = String(source.client_secret || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Invalid OAuth JSON: client_id and client_secret are required.');
  }
  return {
    parsed,
    clientId,
    clientSecret,
    projectId: String(source.project_id || '').trim(),
    clientType: parsed?.web ? 'web' : 'installed',
  };
}

function applyOAuthJsonToForm(parsedPayload, fileName = '') {
  const clientIdEl = document.getElementById('client-id');
  const clientSecretEl = document.getElementById('client-secret');
  const oauthTextEl = document.getElementById('oauth-json-text');
  const oauthPathEl = document.getElementById('oauth-json');
  const fileNameEl = document.getElementById('oauth-file-name');

  clientIdEl.value = parsedPayload.clientId || '';
  clientSecretEl.value = parsedPayload.clientSecret || '';
  oauthTextEl.value = JSON.stringify(parsedPayload.parsed, null, 2);
  oauthPathEl.value = fileName || 'oauth-client.json';
  fileNameEl.textContent = fileName || 'oauth-client.json';
  oauthJsonValidationError = '';
}

async function validateOAuthJsonWithBackend(parsedPayload) {
  if (typeof window.api?.validateOAuthJson !== 'function') return parsedPayload;
  const response = await window.api.validateOAuthJson({
    oauth_json_text: JSON.stringify(parsedPayload.parsed),
  });
  if (!response?.valid) {
    throw new Error(response?.error || 'OAuth JSON validation failed.');
  }
  return {
    ...parsedPayload,
    clientId: response.client_id || parsedPayload.clientId,
    clientSecret: response.client_secret || parsedPayload.clientSecret,
  };
}

async function importOAuthJsonFile(file) {
  if (!file) return;
  const text = await file.text();
  const localParsed = parseGoogleOAuthJson(text);
  const validated = await validateOAuthJsonWithBackend(localParsed);
  applyOAuthJsonToForm(validated, file.name || '');
  setChannelFormMessage('OAuth JSON imported successfully.', 'success');
}

function ensureOAuthFileInput() {
  let input = document.getElementById('oauth-json-file-input');
  if (input) return input;
  input = document.createElement('input');
  input.id = 'oauth-json-file-input';
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async (event) => {
    const file = event.target?.files?.[0];
    try {
      await importOAuthJsonFile(file);
    } catch (error) {
      oauthJsonValidationError = error.message || 'OAuth JSON import failed.';
      setChannelFormMessage(oauthJsonValidationError);
    } finally {
      input.value = '';
    }
  });
  return input;
}

function setupOAuthDropZone() {
  const zone = document.getElementById('oauth-drop-zone');
  if (!zone) return;

  ['dragenter', 'dragover'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('active');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('active');
    });
  });
  zone.addEventListener('drop', async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      await importOAuthJsonFile(file);
    } catch (error) {
      oauthJsonValidationError = error.message || 'OAuth JSON import failed.';
      setChannelFormMessage(oauthJsonValidationError);
    }
  });
}

function updateDriveAuthUI() {
  const statusEl = document.getElementById('drive-auth-status');
  const connectBtn = document.getElementById('drive-auth-connect');
  if (statusEl) {
    if (state.driveAuth?.connected) {
      const email = state.driveAuth.email ? ` (${state.driveAuth.email})` : '';
      statusEl.textContent = `Google Drive connected${email}`;
    } else {
      statusEl.textContent = 'Google Drive not connected.';
    }
  }
  if (connectBtn) {
    connectBtn.textContent = state.driveAuth?.connected ? 'Reconnect Google Drive' : 'Connect Google Drive';
  }
}

function updateDriveFolderSelect(options) {
  const select = document.getElementById('drive-folder-select');
  if (!select) return;
  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = options.length ? 'Select a Google Drive folder' : 'No folders found';
  select.appendChild(placeholder);

  options.forEach((folder) => {
    const opt = document.createElement('option');
    opt.value = folder.id || '';
    opt.textContent = folder.name || folder.link || 'Drive Folder';
    select.appendChild(opt);
  });

  if (state.driveFolders && state.driveFolders.length) {
    const linked = String(state.driveFolders[0] || '');
    const match = options.find((folder) => String(folder.link || '') === linked);
    if (match && match.id) {
      select.value = match.id;
    }
  }
}

async function refreshDriveAuthStatus() {
  try {
    const status = await window.api.getDriveAuthStatus();
    state.driveAuth = {
      connected: Boolean(status?.connected),
      email: String(status?.email || ''),
    };
  } catch (error) {
    state.driveAuth = { connected: false, email: '' };
    const errorEl = document.getElementById('drive-folder-error');
    if (errorEl) errorEl.textContent = error.message || 'Drive auth status failed.';
  }
  updateDriveAuthUI();
}

async function refreshDriveFolderOptions() {
  if (!state.driveAuth?.connected) {
    state.driveFolderOptions = [];
    updateDriveFolderSelect([]);
    return;
  }
  try {
    const response = await window.api.listDriveFolders();
    const folders = Array.isArray(response?.folders) ? response.folders : [];
    state.driveFolderOptions = folders;
    updateDriveFolderSelect(folders);
  } catch (error) {
    state.driveFolderOptions = [];
    updateDriveFolderSelect([]);
    const errorEl = document.getElementById('drive-folder-error');
    if (errorEl) errorEl.textContent = error.message || 'Failed to load Drive folders.';
  }
}

async function loadConnectedDriveFolders() {
  try {
    const response = await window.api.getConnectedDriveFolders();
    const folders = Array.isArray(response?.folders) ? response.folders : [];
    if (folders.length) {
      state.driveFolders = folders.map((folder) => folder.link || '').filter(Boolean);
      const selectedLabel = document.getElementById('drive-folder-selected');
      if (selectedLabel) {
        const names = folders.map((folder) => folder.name || folder.link || 'Drive Folder');
        selectedLabel.textContent = `Selected folders: ${names.join(', ')}`;
      }
    }
  } catch (_) {}
}

function renderAiStatus() {
  const statusEl = document.getElementById('ai-system-status');
  const summaryEl = document.getElementById('ai-system-summary');
  if (!statusEl || !summaryEl) return;

  const data = state.ai.systemData;
  if (!data) {
    statusEl.textContent = 'Unavailable';
    statusEl.classList.remove('status-ok', 'status-warn');
    summaryEl.textContent = 'System data unavailable.';
    return;
  }

  const apiHealth = data.apiHealth || {};
  const ok = apiHealth.youtube === 'OK' && apiHealth.drive === 'OK';
  statusEl.textContent = ok ? 'Healthy' : 'Needs Attention';
  statusEl.classList.toggle('status-ok', ok);
  statusEl.classList.toggle('status-warn', !ok);

  const channelCount = Array.isArray(data.channels) ? data.channels.length : 0;
  const videoCount = Array.isArray(data.videos) ? data.videos.length : 0;
  const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
  summaryEl.textContent = `Channels: ${channelCount} · Videos: ${videoCount} · Automation: ${data.automationStatus || 'OFF'} · Errors: ${errorCount}`;
}

function renderAiDebug() {
  const systemPre = document.getElementById('ai-system-data');
  const logsPre = document.getElementById('ai-system-logs');
  if (!systemPre || !logsPre) return;
  const data = state.ai.systemData || {};
  systemPre.textContent = JSON.stringify(data, null, 2);
  logsPre.textContent = JSON.stringify(data.logs || [], null, 2);

  const aiLogWrap = document.getElementById('ai-action-logs');
  const incidentWrap = document.getElementById('ai-incident-logs');
  const filterEl = document.getElementById('incident-filter');
  const searchEl = document.getElementById('incident-search');
  const archiveHint = document.getElementById('incident-archive-hint');
  const countErrorEl = document.getElementById('incident-count-error');
  const countWarnEl = document.getElementById('incident-count-warn');
  const countInfoEl = document.getElementById('incident-count-info');
  if (aiLogWrap) {
    const logs = Array.isArray(data.logs) ? data.logs : [];
    const aiLogs = logs.filter((log) => String(log.message || "").includes("[AI_ACTION]")).slice(0, 20);
    aiLogWrap.innerHTML = aiLogs.length
      ? aiLogs.map((log) => `<div class="log-entry">${escapeHtml(log.message || "")}</div>`).join('')
      : '<p class="hint">No AI actions yet.</p>';
  }
  if (incidentWrap) {
    const incidents = Array.isArray(data.errors) ? data.errors : [];
    const counts = { error: 0, warn: 0, info: 0 };
    const archiveDays = 7;
    const now = Date.now();
    const archived = [];
    const recent = incidents.filter((log) => {
      const createdAt = String(log.created_at || log.timestamp || "").trim();
      const timeMs = createdAt ? new Date(createdAt).getTime() : now;
      const level = String(log.level || '').toLowerCase();
      const sev = level === 'error' ? 'error' : (level === 'warn' || level === 'warning' ? 'warn' : 'info');
      counts[sev] += 1;
      if (Number.isFinite(timeMs) && now - timeMs > archiveDays * 24 * 60 * 60 * 1000) {
        archived.push(log);
        return false;
      }
      return true;
    });

    if (countErrorEl) countErrorEl.textContent = `ERROR ${counts.error}`;
    if (countWarnEl) countWarnEl.textContent = `WARN ${counts.warn}`;
    if (countInfoEl) countInfoEl.textContent = `INFO ${counts.info}`;
    if (archiveHint) {
      archiveHint.textContent = archived.length
        ? `Archived ${archived.length} incidents older than ${archiveDays} days.`
        : '';
    }

    const filter = filterEl ? String(filterEl.value || 'all') : 'all';
    const term = searchEl ? String(searchEl.value || '').trim().toLowerCase() : '';
    const filtered = recent.filter((log) => {
      const level = String(log.level || '').toLowerCase();
      const message = String(log.message || log.error || "").toLowerCase();
      if (term && !message.includes(term)) return false;
      if (filter === 'all') return true;
      if (filter === 'warn') return level === 'warn' || level === 'warning';
      if (filter === 'error') return level === 'error';
      if (filter === 'info') return level === 'info';
      return true;
    });
    incidentWrap.innerHTML = filtered.length
      ? filtered.map((log, idx) => {
        const level = String(log.level || '').toLowerCase();
        const severity = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info');
        const label = severity.toUpperCase();
        const message = escapeHtml(log.message || log.error || "");
        const timestamp = escapeHtml(String(log.created_at || log.timestamp || ""));
        return `
          <div class="log-entry log-row">
            <button class="incident-toggle" data-incident-index="${idx}" aria-label="Toggle details"></button>
            <span class="severity-badge ${severity}">${label}</span>
            <span class="incident-message">${message}</span>
          </div>
          <div class="incident-details hidden" data-incident-details="${idx}">
            <div><strong>Time:</strong> ${timestamp || '--'}</div>
            <div><strong>Raw:</strong> ${escapeHtml(JSON.stringify(log))}</div>
          </div>
        `;
      }).join('')
      : '<p class="hint">No incidents detected.</p>';

    incidentWrap.querySelectorAll('.incident-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = btn.getAttribute('data-incident-index');
        const detail = incidentWrap.querySelector(`[data-incident-details="${idx}"]`);
        if (detail) detail.classList.toggle('hidden');
      });
    });
  }
}

function exportIncidentsCsv() {
  const data = state.ai.systemData || {};
  const incidents = Array.isArray(data.errors) ? data.errors : [];
  if (!incidents.length) {
    addAiMessage('assistant', 'No incidents to export.');
    return;
  }
  const rows = [
    ['level', 'message', 'created_at'],
    ...incidents.map((log) => [
      String(log.level || ''),
      String(log.message || log.error || ''),
      String(log.created_at || log.timestamp || ''),
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ganga-ai-incidents-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderAiChat() {
  const feed = document.getElementById('chat');
  if (!feed) return;
  feed.innerHTML = '';
  state.ai.messages.forEach((msg) => {
    const bubble = document.createElement('div');
    bubble.className = msg.role === 'user' ? 'msg user' : 'msg ai';
    bubble.textContent = msg.text;
    feed.appendChild(bubble);
  });
  feed.scrollTop = feed.scrollHeight;
}

function addAiMessage(role, text) {
  state.ai.messages.push({ role, text });
  renderAiChat();
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = 'en-IN';
  window.speechSynthesis.speak(speech);
}

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addAiMessage('assistant', 'Voice not supported in this browser.');
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-IN';
  recognition.start();
  recognition.onresult = async (event) => {
    const text = event.results[0][0].transcript;
    addAiMessage('user', text);
    await sendAiMessage(text);
  };
}

function renderAiSuggestions(suggestions = []) {
  const wrap = document.getElementById('ai-suggestions');
  if (!wrap) return;
  wrap.innerHTML = '';
  suggestions.forEach((suggestion) => {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = suggestion;
    btn.addEventListener('click', () => sendAiMessage(suggestion));
    wrap.appendChild(btn);
  });
}

async function refreshAiSystemData() {
  try {
    const data = await window.api.getSystemData();
    state.ai.systemData = data;
    renderAiStatus();
    renderAiDebug();
  } catch (error) {
    state.ai.lastError = error.message || String(error);
    renderAiStatus();
  }
}

async function runAiAction(action) {
  const statusEl = document.getElementById('ai-action-status');
  if (statusEl) statusEl.textContent = 'Running action...';
  try {
    const res = await window.api.aiAction({ action });
    if (res?.data?.data?.url) {
      window.location.href = res.data.data.url;
      return;
    }
    addAiMessage('assistant', res?.message || 'Action completed.');
    speak(res?.message || '');
    await refreshAiSystemData();
  } catch (error) {
    addAiMessage('assistant', `Action error: ${error.message || error}`);
  } finally {
    if (statusEl) statusEl.textContent = '';
  }
}

async function sendAiMessage(explicitText) {
  const input = document.getElementById('ai-input');
  const statusEl = document.getElementById('ai-chat-status');
  if (!input && !explicitText) return;
  const text = String(explicitText || input.value || '').trim();
  if (!text) return;
  if (input) input.value = '';
  if (!explicitText) addAiMessage('user', text);
  if (statusEl) statusEl.textContent = 'Thinking...';
  try {
    const systemData = state.ai.systemData || state.data?.systemData || {};
    const response = await window.api.aiChat({ message: text, systemData });
    if (response?.action?.action) {
      await refreshAiSystemData();
    }
    if (response?.action?.message) {
      const msg = `${response.reply || ''}\n\nAction: ${response.action.message}`.trim();
      addAiMessage('assistant', msg);
      speak(response.reply || '');
    } else {
      addAiMessage('assistant', response.reply || 'No response from AI.');
      speak(response.reply || '');
    }
    renderAiSuggestions(response?.suggestions || []);
  } catch (error) {
    addAiMessage('assistant', `AI error: ${error.message || error}`);
  } finally {
    if (statusEl) statusEl.textContent = '';
  }
}

document.getElementById('pick-oauth').addEventListener('click', async () => {
  try {
    const result = await window.api.selectOAuthJson();
    if (result && typeof result === 'object' && result.oauthJsonText) {
      const localParsed = parseGoogleOAuthJson(result.oauthJsonText);
      const validated = await validateOAuthJsonWithBackend(localParsed);
      applyOAuthJsonToForm(validated, result.fileName || result.path || '');
      setChannelFormMessage('OAuth JSON imported successfully.', 'success');
      return;
    }
    if (typeof result === 'string' && result.trim()) {
      document.getElementById('oauth-json').value = result;
      const parts = result.split(/[\\/]/);
      document.getElementById('oauth-file-name').textContent = parts[parts.length - 1];
      setChannelFormMessage('');
      return;
    }
    ensureOAuthFileInput().click();
  } catch (error) {
    oauthJsonValidationError = error.message || 'OAuth JSON import failed.';
    setChannelFormMessage(oauthJsonValidationError);
  }
});

setupOAuthDropZone();

document.getElementById('connect-channel').addEventListener('click', async () => {
  if (channelConnectInProgress) return;

  if (oauthJsonValidationError) {
    setChannelFormMessage(oauthJsonValidationError);
    return;
  }

  const payload = {
    clientId: document.getElementById('client-id').value.trim(),
    clientSecret: document.getElementById('client-secret').value.trim(),
    apiKey: document.getElementById('api-key').value.trim(),
    channelUrl: document.getElementById('channel-url').value.trim(),
    oauthJsonPath: document.getElementById('oauth-json').value.trim(),
    oauthJsonText: document.getElementById('oauth-json-text').value.trim(),
  };

  if (!payload.clientId || !payload.clientSecret) {
    setChannelFormMessage('Please fill Client ID and Client Secret.');
    return;
  }

  channelConnectInProgress = true;
  setChannelFormMessage('');
  setChannelLoading(true);

  let timeoutHandle = null;
  try {
    await Promise.race([
      window.api.addChannel(payload),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('__CHANNEL_CONNECT_TIMEOUT__')), 30000);
      }),
    ]);
    setChannelLoading(false);
    resetChannelForm();
    document.getElementById('channel-modal').classList.add('hidden');
    showChannelToast('Channel added. Click Get Token from channel row.', 'success');
    await loadState();
  } catch (error) {
    setChannelLoading(false);
    const message = mapChannelConnectError(error);
    setChannelFormMessage(message);
    showChannelToast(message, 'error');
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    channelConnectInProgress = false;
    setChannelLoading(false);
  }
});

document.getElementById('ai-send')?.addEventListener('click', sendAiMessage);
document.getElementById('ai-input')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendAiMessage();
  }
});
document.getElementById('ai-mic')?.addEventListener('click', startVoice);
document.querySelectorAll('[data-ai-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.getAttribute('data-ai-action');
    if (!action) return;
    await runAiAction(action);
  });
});
document.getElementById('incident-filter')?.addEventListener('change', () => {
  renderAiDebug();
});
document.getElementById('incident-search')?.addEventListener('input', () => {
  renderAiDebug();
});
document.getElementById('incident-export')?.addEventListener('click', exportIncidentsCsv);

loadState().then(() => {
  if (isLibraryPageActive()) {
    fetchDriveVideos();
  }
  startDriveAutoRefresh();
  refreshAiSystemData();
});
refreshInternet();
setInterval(refreshInternet, 15000);
setInterval(refreshAutomationStatus, 20000);
setInterval(refreshAutomationUpgradeStatus, 20000);
setInterval(refreshAiSystemData, 5000);
setInterval(async () => {
  if (!isAiPageActive()) return;
  if (!state.ai.systemData) return;
  if (Array.isArray(state.ai.systemData.errors) && state.ai.systemData.errors.length > 0) {
    await sendAiMessage("fix all issues automatically");
  }
}, 15000);
