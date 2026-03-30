const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { google } = require('googleapis');
const { buildOAuthClientFromChannel } = require('./youtube');
const { decryptObject, encryptObject } = require('./secureStore');
const { updateState, loadState } = require('./storage');
const {
  normalizeSlotPlan: normalizeHumanSlotPlan,
  prepareHumanizedSlotPlans,
  isSlotDueForUpload,
  parseDateTime,
} = require('../../utils/scheduler_engine');
const YOUTUBE_DAILY_QUOTA_UNITS = 10000;
const YOUTUBE_UPLOAD_COST_UNITS = 1600;
const MAX_UPLOADS_PER_CYCLE = 1;

async function checkInternet() {
  try {
    await dns.resolve('www.google.com');
    return true;
  } catch (err) {
    return false;
  }
}

function isChannelSelected(channel) {
  return channel?.is_selected !== false && channel?.selected !== false;
}

function parseTags(rawTags) {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) {
    return rawTags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  return String(rawTags)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function downloadDriveFile(drive, fileId, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    response.data
      .on('error', reject)
      .pipe(writer)
      .on('error', reject)
      .on('finish', resolve);
  });
}

function shuffleArray(input) {
  const arr = Array.isArray(input) ? input.slice() : [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

function buildDailyRandomOffsets({ count, min = 1, max = 3, lastPattern = '' }) {
  const safeCount = Math.max(0, Number(count || 0));
  if (!safeCount) return { offsets: [], pattern: '' };

  let best = Array.from({ length: safeCount }, () => getRandomIntInclusive(min, max));
  let pattern = best.join(',');
  if (!lastPattern || pattern !== String(lastPattern || '')) {
    return { offsets: best, pattern };
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const next = Array.from({ length: safeCount }, () => getRandomIntInclusive(min, max));
    const nextPattern = next.join(',');
    if (nextPattern !== String(lastPattern || '')) {
      return { offsets: next, pattern: nextPattern };
    }
    best = next;
    pattern = nextPattern;
  }

  const rotated = best.slice(1).concat(best[0]);
  return { offsets: rotated, pattern: rotated.join(',') };
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

function parseTitlePool(rawTitles) {
  if (Array.isArray(rawTitles)) {
    return rawTitles.map((title) => String(title || '').trim()).filter(Boolean);
  }
  return String(rawTitles || '')
    .split(/\r?\n/)
    .map((title) => title.trim())
    .filter(Boolean);
}

function buildSafeUploadTitle(video, state, uploadIndex) {
  const assigned = String(video.assigned_title || video.title || '').trim();
  if (assigned) return assigned;

  const titlePool = parseTitlePool(state.settings?.titlePool || []);
  if (titlePool.length > 0) {
    return titlePool[uploadIndex % titlePool.length];
  }

  const prefix = String(state.settings?.defaultTitlePrefix || '').trim() || 'GDA Upload';
  return `${prefix} ${Date.now() + uploadIndex}`;
}

function normalizeSlotPlan(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots
    .map((slot, index) => {
      const date = String(slot?.date || '').trim();
      const time = String(slot?.time || '').trim();
      const timeMatch = time.match(/^(\d{1,2}):(\d{2})$/);
      if (!timeMatch) return null;
      const hh = Number(timeMatch[1]);
      const mm = Number(timeMatch[2]);
      if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        return null;
      }
      return {
        slotNumber: Number(slot?.slot_number || (index + 1)),
        date,
        time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
        videoId: String(slot?.videoId || '').trim(),
        title: String(slot?.title || '').trim(),
      };
    })
    .filter(Boolean);
}

function buildDistributedTomorrowPlan(videos, count) {
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
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  return slotNumbers.map((slotNumber, index) => {
    const fixed = fixedTimes[slotNumber] || fixedTimes[5];
    const video = videos[index] || null;
    return {
      slotNumber,
      date,
      time: `${String(fixed.hour).padStart(2, '0')}:${String(fixed.minute).padStart(2, '0')}`,
      videoId: video?.id || '',
      title: String(video?.assigned_title || video?.title || '').trim(),
    };
  });
}

function buildPublishAtIso(slot, fallbackIndex = 0) {
  const rawDate = String(slot?.date || '').trim();
  const rawTime = String(slot?.time || '').trim();
  const match = rawTime.match(/^(\d{2}):(\d{2})$/);
  const now = new Date();

  if (rawDate && match) {
    const dateParts = rawDate.split('-').map((part) => Number(part));
    if (dateParts.length === 3) {
      const [y, m, d] = dateParts;
      const hh = Number(match[1]);
      const mm = Number(match[2]);
      const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
      if (!Number.isNaN(dt.getTime())) {
        if (dt <= now) {
          dt.setDate(dt.getDate() + 1);
        }
        return dt.toISOString();
      }
    }
  }

  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(4 + (fallbackIndex * 4), 0, 0, 0);
  return fallback.toISOString();
}

function getErrorCode(error) {
  return String(error?.code || error?.cause?.code || '').trim().toUpperCase();
}

function getHttpStatus(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function isTransientUploadError(error) {
  const code = getErrorCode(error);
  const status = getHttpStatus(error);
  const message = String(error?.message || '').toLowerCase();

  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED'].includes(code)) {
    return true;
  }

  if (status === 429 || status >= 500) {
    return true;
  }

  return (
    message.includes('socket hang up')
    || message.includes('network error')
    || message.includes('timed out')
    || message.includes('econnreset')
  );
}

function getRetryDelayMs(attemptIndex) {
  const base = 1500;
  const maxDelay = 15000;
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(maxDelay, base * (2 ** attemptIndex) + jitter);
}

async function retryAsyncOperation(action, { attempts = 3, onRetry } = {}) {
  let attempt = 0;
  let lastError = null;
  while (attempt < attempts) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1) break;
      const delayMs = getRetryDelayMs(attempt);
      if (typeof onRetry === 'function') {
        onRetry({ attempt: attempt + 1, delayMs, error });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
  throw lastError;
}

async function uploadToYoutubeWithRetry({ youtube, request, log, uploadTitle, maxRetries = 3 }) {
  let attempt = 0;
  while (true) {
    try {
      return await youtube.videos.insert(request);
    } catch (error) {
      const transient = isTransientUploadError(error);
      if (!transient || attempt >= maxRetries) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt);
      const errorCode = getErrorCode(error) || 'UNKNOWN';
      const status = getHttpStatus(error);
      const statusText = status ? `HTTP ${status}` : 'no-http-status';
      log(`[UPLOAD_RETRY] ${uploadTitle} :: ${statusText} ${errorCode} :: retry ${attempt + 1}/${maxRetries} in ${Math.round(delayMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

function createUploader({ log, progress }) {
  let stopRequested = false;

  function isUploadLimitExceededError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return (
      message.includes('exceeded the number of videos they may upload')
      || message.includes('uploadlimitexceeded')
      || message.includes('dailylimitexceeded')
      || message.includes('quota exceeded')
    );
  }

  function emitProgress(payload) {
    progress({
      uploadedBytes: payload.uploadedBytes || 0,
      totalBytes: payload.totalBytes || 0,
      completedVideos: payload.completedVideos || 0,
      totalVideos: payload.totalVideos || 0,
    });
  }

  function toLocalDateKey(value = new Date()) {
    const date = new Date(value);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  async function startUploads() {
    stopRequested = false;
    const internetOk = await checkInternet();
    if (!internetOk) {
      throw new Error('No internet connection detected.');
    }

    const state = loadState();
    const selectedChannels = (state.channels || []).filter((channel) => (
      isChannelSelected(channel) && channel.token_status === 'connected'
    ));
    const selectedAutomationIds = Array.isArray(state.settings?.selectedAutomationChannelIds)
      ? state.settings.selectedAutomationChannelIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const activeChannels = selectedAutomationIds.length
      ? selectedChannels.filter((channel) => selectedAutomationIds.includes(String(channel.id || '').trim()))
      : selectedChannels;
    if (!selectedChannels.length) {
      throw new Error('No connected channel selected.');
    }
    if (!activeChannels.length) {
      throw new Error('No active channels selected in Automation Scheduler.');
    }

    const pendingVideos = (state.videos || []).filter((video) => video.status === 'pending' && video.drive_file_id);
    const configuredPerDay = Math.max(1, Math.min(5, Number(state.settings?.videosPerDay || 5)));

    if (!pendingVideos.length) {
      log('No pending videos found in queue.');
      return { uploaded: 0, total: 0, limit: configuredPerDay };
    }

    const pendingById = new Map(pendingVideos.map((video) => [String(video.id || '').trim(), video]));
    const usedVideoIds = new Set();
    const dayKey = toLocalDateKey();
    const titlePool = parseTitlePool(state.settings?.titlePool || []);
    const channelSlotPlansRaw = state.settings?.channelSlotPlans && typeof state.settings.channelSlotPlans === 'object'
      ? state.settings.channelSlotPlans
      : {};
    const generatedPlans = {};
    const schedulerConfig = state.settings?.schedulerConfig && typeof state.settings.schedulerConfig === 'object'
      ? state.settings.schedulerConfig
      : {};
    const minGapHours = Math.max(1, Number(schedulerConfig.minGapHours || 2));
    const maxGapHours = Math.max(minGapHours, Number(schedulerConfig.maxGapHours || 6));
    const timeVariationMinutes = Math.max(0, Number(schedulerConfig.timeVariationMinutes || 30));
    const enableDailyShift = schedulerConfig.enableDailyShift !== false;

    activeChannels.forEach((channel) => {
      const channelPlan = normalizeHumanSlotPlan(channelSlotPlansRaw[channel.id] || state.settings?.slots || []).slice(0, configuredPerDay);
      if (channelPlan.length) {
        generatedPlans[channel.id] = channelPlan;
        return;
      }
      const fallback = buildDistributedTomorrowPlan(shuffleArray(pendingVideos), configuredPerDay).map((slot) => ({
        slot_number: Number(slot.slotNumber),
        date: String(slot.date || ''),
        time: String(slot.time || ''),
        videoId: String(slot.videoId || ''),
        title: String(slot.title || ''),
        status: 'scheduled',
        upload_date: '',
        upload_time: '',
        manual_upload_time: false,
      }));
      generatedPlans[channel.id] = fallback;
    });

    const humanizedPlans = prepareHumanizedSlotPlans({
      channelSlotPlans: generatedPlans,
      channelIds: activeChannels.map((channel) => channel.id),
      now: new Date(),
      minGapMinutes: Math.round(minGapHours * 60),
      maxGapMinutes: Math.round(maxGapHours * 60),
      minLeadMinutes: 45,
      variationMinutes: timeVariationMinutes,
      enableDailyShift,
    });

    const persistedAutomation = state.settings?.automationIntelligence && typeof state.settings.automationIntelligence === 'object'
      ? state.settings.automationIntelligence
      : {};
    const persistedHistory = state.settings?.uploadedVideosByChannel && typeof state.settings.uploadedVideosByChannel === 'object'
      ? state.settings.uploadedVideosByChannel
      : {};

    const workingAutomation = JSON.parse(JSON.stringify(persistedAutomation));
    const workingHistory = JSON.parse(JSON.stringify(persistedHistory));
    const perChannelLimits = {};
    let expectedTotal = 0;

    activeChannels.forEach((channel) => {
      const channelPlan = Array.isArray(humanizedPlans[channel.id]) ? humanizedPlans[channel.id] : [];
      const dueSlots = channelPlan.filter((slot) => isSlotDueForUpload(slot, new Date()));
      const limit = Math.min(configuredPerDay, dueSlots.length);
      perChannelLimits[channel.id] = limit;
      expectedTotal += limit;
    });

    emitProgress({
      totalVideos: expectedTotal,
      completedVideos: 0,
      totalBytes: expectedTotal,
      uploadedBytes: 0,
    });

    let completed = 0;
    let haltedByLimit = false;
    let cycleUploads = 0;

    updateState((nextState) => {
      nextState.settings = nextState.settings || {};
      nextState.settings.channelSlotPlans = {
        ...(nextState.settings.channelSlotPlans || {}),
        ...humanizedPlans,
      };
      return nextState;
    });

    for (let channelIndex = 0; channelIndex < activeChannels.length; channelIndex += 1) {
      if (stopRequested) break;
      if (cycleUploads >= MAX_UPLOADS_PER_CYCLE) break;
      const channel = activeChannels[channelIndex];
      const channelId = String(channel.id || '').trim();
      const channelName = channel.channel_name || channel.title || channel.id;
      let oauth2Client;
      try {
        oauth2Client = buildOAuthClientFromChannel(channel);
      } catch (error) {
        log(`[CHANNEL_SKIP] ${channelName} :: invalid token data`);
        continue;
      }

      oauth2Client.on('tokens', (tokens) => {
        updateState((nextState) => {
          const target = (nextState.channels || []).find((item) => item.id === channel.id);
          if (!target) return nextState;
          const currentTokens = decryptObject(target.tokensEncrypted) || {};
          target.tokensEncrypted = encryptObject({ ...currentTokens, ...tokens });
          return nextState;
        });
      });

      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      let channelUploaded = 0;
      const todayKey = toLocalDateKey();
      const uploadedTodayForChannel = (state.videos || []).filter((video) => (
        video?.status === 'uploaded'
        && String(video?.uploaded_channel_id || '').trim() === channelId
        && String(video?.uploaded_at || '').startsWith(todayKey)
      )).length;
      const usedChannelQuota = uploadedTodayForChannel * YOUTUBE_UPLOAD_COST_UNITS;
      let channelQuotaRemaining = Math.max(0, YOUTUBE_DAILY_QUOTA_UNITS - usedChannelQuota);
      log(`Checking quota for channel... ${channelName}`);
      log(`Quota available: ${channelQuotaRemaining}`);
      console.log('Checking quota for channel...', channelName);
      console.log('Quota available:', channelQuotaRemaining);
      const perChannelLimit = Number(perChannelLimits[channel.id] || configuredPerDay);
      const slotPlan = (Array.isArray(humanizedPlans[channel.id]) ? humanizedPlans[channel.id] : [])
        .slice()
        .filter((slot) => isSlotDueForUpload(slot, new Date()))
        .sort((a, b) => {
          const left = parseDateTime(a.upload_date, a.upload_time)?.getTime() || Number.MAX_SAFE_INTEGER;
          const right = parseDateTime(b.upload_date, b.upload_time)?.getTime() || Number.MAX_SAFE_INTEGER;
          return left - right;
        });
      if (!slotPlan.length) {
        log(`[CHANNEL_SKIP] ${channelName} has no due upload slots right now.`);
        continue;
      }
      const historyList = Array.isArray(workingHistory[channelId]) ? workingHistory[channelId].map((id) => String(id || '').trim()).filter(Boolean) : [];
      const uploadedHistory = new Set(historyList);

      const channelMeta = workingAutomation[channelId] && typeof workingAutomation[channelId] === 'object'
        ? workingAutomation[channelId]
        : {};
      const candidateIds = pendingVideos
        .map((video) => String(video.id || '').trim())
        .filter(Boolean)
        .filter((id) => !uploadedHistory.has(id));
      let videoOrder = Array.isArray(channelMeta.videoOrder) ? channelMeta.videoOrder.map((id) => String(id || '').trim()).filter(Boolean) : [];
      const shouldRefreshOrder = (
        !videoOrder.length
        || channelMeta.videoOrderDay !== dayKey
        || videoOrder.some((id) => !candidateIds.includes(id))
        || candidateIds.some((id) => !videoOrder.includes(id))
      );
      if (shouldRefreshOrder) {
        let nextOrder = shuffleArray(candidateIds);
        if (arraysEqual(nextOrder, videoOrder) && nextOrder.length > 1) {
          nextOrder = nextOrder.slice(1).concat(nextOrder[0]);
        }
        videoOrder = nextOrder;
      }
      let videoPointer = Math.max(0, Number(channelMeta.videoPointer || 0));

      let titleOrder = Array.isArray(channelMeta.titleOrder) ? channelMeta.titleOrder.map((t) => String(t || '').trim()).filter(Boolean) : [];
      if (titlePool.length) {
        const shouldRefreshTitleOrder = (
          !titleOrder.length
          || channelMeta.titleOrderDay !== dayKey
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
      let titlePointer = Math.max(0, Number(channelMeta.titlePointer || 0));
      let lastTitle = String(channelMeta.lastTitle || '').trim();

      const pattern = String(channelMeta.lastOffsetPattern || '');

      const nextTitle = (fallbackTitle, slotTitle = '') => {
        const hardSlotTitle = String(slotTitle || '').trim();
        if (hardSlotTitle && hardSlotTitle !== lastTitle) {
          lastTitle = hardSlotTitle;
          return hardSlotTitle;
        }

        if (titleOrder.length) {
          for (let i = 0; i < titleOrder.length; i += 1) {
            const idx = (titlePointer + i) % titleOrder.length;
            const candidate = String(titleOrder[idx] || '').trim();
            if (!candidate) continue;
            titlePointer = (idx + 1) % titleOrder.length;
            if (candidate !== lastTitle || titleOrder.length === 1) {
              lastTitle = candidate;
              return candidate;
            }
          }
        }

        const fallback = String(fallbackTitle || '').trim();
        if (fallback && fallback !== lastTitle) {
          lastTitle = fallback;
          return fallback;
        }
        return fallback || buildSafeUploadTitle({ assigned_title: '', title: '' }, state, titlePointer);
      };

      const takeNextVideoCandidate = (preferredId, triedIds) => {
        const trimmedPreferred = String(preferredId || '').trim();
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
          const candidateId = String(videoOrder[idx] || '').trim();
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

      for (let slotIndex = 0; slotIndex < perChannelLimit; slotIndex += 1) {
        if (stopRequested) break;
        if (cycleUploads >= MAX_UPLOADS_PER_CYCLE) break;
        if (channelQuotaRemaining < YOUTUBE_UPLOAD_COST_UNITS) {
          log(`[QUOTA_STOP] ${channelName} quota low; stopping channel uploads for now.`);
          break;
        }
        const slot = slotPlan[slotIndex] || {};
        const preferredId = String(slot.videoId || '').trim();
        const triedVideoIds = new Set();
        let slotUploaded = false;
        const publishAt = buildPublishAtIso(slot, slotIndex);

        while (!slotUploaded && !stopRequested) {
          const video = takeNextVideoCandidate(preferredId, triedVideoIds);
          if (!video) break;
          triedVideoIds.add(String(video.id || '').trim());
          const tempPath = path.join(os.tmpdir(), `gda-${channel.id}-${video.id}-${Date.now()}.mp4`);
          const uploadTitle = nextTitle(
            buildSafeUploadTitle(video, state, slotIndex),
            String(slot.title || '').trim(),
          );
          const description = String(
            state.settings?.globalDescription
            || state.settings?.defaultDescription
            || 'Uploaded via Ganga Digital Automation'
          ).trim();
          const tags = parseTags(state.settings?.globalTags || '');

          try {
            const activeAccessToken = String(oauth2Client.credentials?.access_token || '');
            console.log('Using Access Token:', activeAccessToken);
            console.log('Scopes:', String(oauth2Client.credentials?.scope || ''));
            console.log('Downloading from Drive...');
            log(`[FETCH] [${channelName}] ${uploadTitle} (${video.drive_file_id})`);
            console.log('Uploading video:', uploadTitle);
            console.log('Scheduled for:', publishAt);
            await retryAsyncOperation(async () => {
              await downloadDriveFile(drive, video.drive_file_id, tempPath);
            }, {
              attempts: 3,
              onRetry: ({ attempt, delayMs, error }) => {
                log(`[DOWNLOAD_RETRY] ${uploadTitle} retry ${attempt}/3 in ${Math.round(delayMs / 1000)}s :: ${error?.message || error}`);
              },
            });

            log(`[UPLOAD_START] ${uploadTitle} -> ${publishAt}`);
            if (slot?.upload_date && slot?.upload_time) {
              log(`[UPLOAD_SLOT] ${channelName} slot ${slot.slot_number} upload window hit at ${slot.upload_date} ${slot.upload_time}`);
            }
            console.log('Uploading to YouTube...');
            const response = await uploadToYoutubeWithRetry({
              youtube,
              log,
              uploadTitle,
              maxRetries: 3,
              request: {
                part: ['snippet', 'status'],
                requestBody: {
                  snippet: {
                    title: uploadTitle,
                    description,
                    tags,
                  },
                  status: {
                    privacyStatus: 'private',
                    publishAt,
                    selfDeclaredMadeForKids: false,
                  },
                },
                media: {
                  body: fs.createReadStream(tempPath),
                },
                uploadType: 'resumable',
              },
            });

            const uploadedVideoId = String(video.id || '').trim();
            usedVideoIds.add(uploadedVideoId);
            uploadedHistory.add(uploadedVideoId);
            workingHistory[channelId] = Array.from(uploadedHistory).slice(-5000);

            updateState((nextState) => {
              const target = (nextState.videos || []).find((item) => item.id === video.id);
              if (target) {
                target.assigned_title = uploadTitle;
                target.title = uploadTitle;
                target.description = description;
                target.tags = tags;
                target.status = 'uploaded';
                target.upload_count = Number(target.upload_count || 0) + 1;
                target.uploaded_at = new Date().toISOString();
                target.scheduled_publish_at = publishAt;
                const uploadAt = parseDateTime(slot?.upload_date, slot?.upload_time);
                target.scheduled_upload_at = uploadAt ? uploadAt.toISOString() : null;
                target.uploaded_channel_id = channelId;
                target.youtube_video_id = response.data.id || null;
              }
              return nextState;
            });

            completed += 1;
            cycleUploads += 1;
            channelUploaded += 1;
            channelQuotaRemaining = Math.max(0, channelQuotaRemaining - YOUTUBE_UPLOAD_COST_UNITS);
            emitProgress({
              totalVideos: expectedTotal,
              completedVideos: completed,
              totalBytes: expectedTotal,
              uploadedBytes: completed,
            });
            log(`[UPLOAD_COMPLETE] ${uploadTitle}`);
            slotUploaded = true;
          } catch (error) {
            const errorText = String(error?.message || error || '');
            if (errorText.includes('insufficientPermissions') || errorText.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
              console.log('ERROR: Missing Drive Scope. Reconnect required.');
            }
            updateState((nextState) => {
              const target = (nextState.videos || []).find((item) => item.id === video.id);
              if (target) {
                target.upload_count = Number(target.upload_count || 0) + 1;
                target.last_error = String(error?.message || error || 'Unknown upload error');
              }
              return nextState;
            });
            log(`[UPLOAD_FAILED] ${(video.assigned_title || video.title || video.id)} :: ${error?.message || error}`);
            if (isUploadLimitExceededError(error)) {
              haltedByLimit = true;
              log('[HALT] YouTube upload limit reached for this account. Stopping current cycle.');
              break;
            }
            log(`[FAILOVER] ${channelName} slot ${slotIndex + 1} trying next available video.`);
          } finally {
            if (fs.existsSync(tempPath)) {
              await fsp.unlink(tempPath).catch(() => {});
            }
          }
        }

        if (haltedByLimit) {
          break;
        }
      }

      workingAutomation[channelId] = {
        ...channelMeta,
        videoOrder,
        videoPointer,
        videoOrderDay: dayKey,
        titleOrder,
        titlePointer,
        titleOrderDay: dayKey,
        lastTitle,
        lastOffsetPattern: pattern,
        lastOffsetDay: dayKey,
        updatedAt: new Date().toISOString(),
      };

      log(`[CHANNEL_DONE] ${channelName} uploaded ${channelUploaded}/${perChannelLimit}`);
      if (haltedByLimit) break;
    }

    updateState((nextState) => {
      nextState.settings = nextState.settings || {};
      nextState.settings.uploadedVideosByChannel = workingHistory;
      nextState.settings.automationIntelligence = workingAutomation;
      nextState.settings.channelSlotPlans = {
        ...(nextState.settings.channelSlotPlans || {}),
        ...humanizedPlans,
      };
      return nextState;
    });

    log(`Automation cycle complete. Uploaded ${completed}/${expectedTotal}.`);
    return {
      uploaded: completed,
      total: expectedTotal,
      limit: configuredPerDay,
      haltedByLimit,
    };
  }

  function requestStop() {
    stopRequested = true;
  }

  return {
    startUploads,
    checkInternet,
    requestStop,
  };
}

module.exports = {
  createUploader,
  checkInternet,
};
