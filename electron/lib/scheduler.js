const path = require('path');

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createSlotTimes(videosPerDay) {
  const presets = {
    1: [{ hour: 4, minute: 0 }],
    2: [{ hour: 4, minute: 0 }, { hour: 16, minute: 0 }],
    3: [{ hour: 4, minute: 0 }, { hour: 12, minute: 0 }, { hour: 20, minute: 0 }],
    4: [{ hour: 4, minute: 0 }, { hour: 10, minute: 0 }, { hour: 16, minute: 0 }, { hour: 22, minute: 0 }],
  };
  if (presets[videosPerDay]) return presets[videosPerDay];

  const startHour = 4;
  const endHour = 22;
  const totalMinutes = (endHour - startHour) * 60;
  const step = totalMinutes / (videosPerDay - 1);
  const slots = [];

  for (let i = 0; i < videosPerDay; i += 1) {
    const minutes = Math.round(i * step);
    const hour = startHour + Math.floor(minutes / 60);
    const minute = minutes % 60;
    slots.push({ hour, minute });
  }

  return slots;
}

function rotateArray(arr, steps) {
  if (!arr.length) return [];
  const normalized = ((steps % arr.length) + arr.length) % arr.length;
  if (normalized === 0) return arr.slice();
  return arr.slice(normalized).concat(arr.slice(0, normalized));
}

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toTitleCase(input) {
  return input.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
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

function parseGlobalTags(rawTags) {
  if (!rawTags) return [];
  if (Array.isArray(rawTags)) {
    return rawTags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  return String(rawTags)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatDateOnly(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTimeOnly(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

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

function generateSchedule({ days, videosPerDay, channels }) {
  const safeDays = clamp(days, 1, 10);
  const safeVideos = clamp(videosPerDay, 1, 8);
  const slots = createSlotTimes(safeVideos);
  const schedules = {};
  const channelsList = channels || [];

  channelsList.forEach((channel) => {
    schedules[channel.id] = [];
  });

  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 1); // Tomorrow only.
  baseDate.setHours(0, 0, 0, 0);

  for (let dayIndex = 0; dayIndex < safeDays; dayIndex += 1) {
    const dayDate = new Date(baseDate);
    dayDate.setDate(baseDate.getDate() + dayIndex);
    const usedTimes = new Set();

    slots.forEach((slot, slotIndex) => {
      channelsList.forEach((channel, channelIndex) => {
        const publishAt = new Date(dayDate);
        publishAt.setHours(slot.hour, slot.minute, 0, 0);

        if (channelIndex > 0) {
          const gapMinutes = randomInt(2, 5);
          publishAt.setMinutes(publishAt.getMinutes() + channelIndex * gapMinutes);
        }

        // Avoid accidental timestamp collisions in the same day.
        while (usedTimes.has(publishAt.getTime())) {
          publishAt.setMinutes(publishAt.getMinutes() + 1);
        }
        usedTimes.add(publishAt.getTime());

        // Safety: never schedule in the past.
        if (publishAt <= new Date()) {
          publishAt.setDate(publishAt.getDate() + 1);
        }

        schedules[channel.id].push({
          id: `${channel.id}-${dayIndex}-${slotIndex}`,
          dayIndex,
          slotIndex,
          date: formatDateOnly(publishAt),
          time: formatTimeOnly(publishAt),
          publishAt: toIsoWithLocalOffset(publishAt),
          videoPath: null,
          title: null,
          description: channel.defaultDescription || 'Uploaded via Ganga Digital Automation',
          tags: [],
          status: 'pending',
        });
      });
    });
  }

  return schedules;
}

function autoAssignVideos({ schedules, channels, videos, settings }) {
  const updated = { ...schedules };
  const videoPool = videos.map((v) => v.path);
  if (!videoPool.length) return updated;

  const defaultTags = parseGlobalTags(settings?.globalTags || '');

  channels.forEach((channel, channelIndex) => {
    const items = (updated[channel.id] || []).slice().sort((a, b) => {
      if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
      return a.slotIndex - b.slotIndex;
    });
    if (!items.length) return;

    const dayIndexes = [...new Set(items.map((item) => item.dayIndex))].sort((a, b) => a - b);
    const baseOrder = shuffle(videoPool);
    let lastAssigned = null;

    dayIndexes.forEach((dayIndex, dayOffset) => {
      const dayItems = items.filter((item) => item.dayIndex === dayIndex);
      const daySequence = rotateArray(baseOrder, dayOffset + channelIndex);

      dayItems.forEach((item, slotIndex) => {
        let candidate = daySequence[slotIndex % daySequence.length] || null;

        // No immediate back-to-back duplicates when avoidable.
        if (daySequence.length > 1 && candidate === lastAssigned) {
          candidate = daySequence[(slotIndex + 1) % daySequence.length];
        }

        item.videoPath = candidate;
        item.title = buildVideoTitle(candidate);
        item.description = (channel.defaultDescription || '').trim() || 'Uploaded via Ganga Digital Automation';
        item.tags = defaultTags.slice();
        item.status = item.status || 'pending';
        lastAssigned = candidate;
      });
    });
  });

  return updated;
}

module.exports = {
  generateSchedule,
  autoAssignVideos,
};
