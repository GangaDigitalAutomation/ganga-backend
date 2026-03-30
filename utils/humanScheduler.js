function toDateOnly(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toTimeOnly(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function parseDateTime(dateRaw, timeRaw) {
  const date = String(dateRaw || '').trim();
  const time = String(timeRaw || '').trim();
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!date || !match) return null;
  const parts = date.split('-').map((value) => Number(value));
  if (parts.length !== 3) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const dt = new Date(parts[0], parts[1] - 1, parts[2], hh, mm, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function hashString(input) {
  let hash = 2166136261;
  const value = String(input || '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed) {
  return hashString(seed) / 4294967295;
}

function seededInt(seed, min, max) {
  const safeMin = Math.ceil(Number(min || 0));
  const safeMax = Math.floor(Number(max || 0));
  return Math.floor(seededUnit(seed) * (safeMax - safeMin + 1)) + safeMin;
}

function getRandomTime(start, end, seed = '') {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return new Date(start);
  }
  const span = endMs - startMs;
  const offset = Math.floor(seededUnit(`${seed}:ms`) * span);
  const secondJitter = seededInt(`${seed}:sec`, 3, 57) * 1000;
  const candidate = new Date(Math.min(endMs, startMs + offset + secondJitter));
  candidate.setMilliseconds(0);
  return candidate;
}

const FIXED_PUBLISH_TIMES = {
  1: { hour: 4, minute: 0 },
  2: { hour: 7, minute: 0 },
  3: { hour: 13, minute: 0 },
  4: { hour: 17, minute: 0 },
  5: { hour: 22, minute: 0 },
};

const DAILY_SLOT_PRESETS = {
  1: [5],
  2: [1, 5],
  3: [1, 4, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
};

// Upload windows are based on publish day.
const SLOT_WINDOWS = {
  1: { startDayOffset: -1, startHour: 15, startMinute: 0, endDayOffset: -1, endHour: 18, endMinute: 0 },
  2: { startDayOffset: -1, startHour: 19, startMinute: 0, endDayOffset: -1, endHour: 21, endMinute: 0 },
  3: { startDayOffset: -1, startHour: 22, startMinute: 0, endDayOffset: 0, endHour: 0, endMinute: 0 },
  4: { startDayOffset: 0, startHour: 1, startMinute: 0, endDayOffset: 0, endHour: 3, endMinute: 0 },
  5: { startDayOffset: 0, startHour: 4, startMinute: 0, endDayOffset: 0, endHour: 6, endMinute: 0 },
};

function getSlotNumbersForDailyCount(videosPerDay) {
  const safe = Math.max(1, Math.min(5, Number(videosPerDay || 1)));
  return DAILY_SLOT_PRESETS[safe] ? DAILY_SLOT_PRESETS[safe].slice() : DAILY_SLOT_PRESETS[1].slice();
}

function normalizeSlot(slot, index = 0) {
  const slotNumber = Number(slot?.slot_number || slot?.slotNumber || (index + 1));
  const autoUploadEnabled = slot?.auto_upload_enabled !== undefined
    ? Boolean(slot.auto_upload_enabled)
    : !Boolean(slot?.manual_upload_time || slot?.manualUploadTime);
  return {
    slot_number: slotNumber,
    publish_date: String(slot?.publish_date || slot?.date || '').trim(),
    publish_time: String(slot?.publish_time || slot?.time || '').trim(),
    date: String(slot?.publish_date || slot?.date || '').trim(),
    time: String(slot?.publish_time || slot?.time || '').trim(),
    videoId: String(slot?.videoId || slot?.video_id || '').trim(),
    title: String(slot?.title || '').trim(),
    status: String(slot?.status || 'pending').trim() || 'pending',
    upload_date: String(slot?.upload_date || slot?.uploadDate || '').trim(),
    upload_time: String(slot?.upload_time || slot?.uploadTime || '').trim(),
    manual_upload_time: !autoUploadEnabled,
    auto_upload_enabled: autoUploadEnabled,
  };
}

function normalizeSlotPlan(rawSlots) {
  if (!Array.isArray(rawSlots)) return [];
  return rawSlots.map((slot, index) => normalizeSlot(slot, index));
}

function ensurePublishDateTime(slot, now = new Date()) {
  const publishAt = parseDateTime(slot.date, slot.time);
  if (publishAt) return publishAt;

  const nextDate = new Date(now);
  nextDate.setDate(nextDate.getDate() + 1);
  nextDate.setHours(0, 0, 0, 0);
  const fixed = FIXED_PUBLISH_TIMES[Math.max(1, Math.min(5, Number(slot.slot_number || 1)))] || FIXED_PUBLISH_TIMES[5];
  nextDate.setHours(fixed.hour, fixed.minute, 0, 0);
  slot.date = toDateOnly(nextDate);
  slot.publish_date = slot.date;
  slot.time = toTimeOnly(nextDate);
  slot.publish_time = slot.time;
  return nextDate;
}

function getWindowBounds(publishAt, slotNumber) {
  const safeSlot = Math.max(1, Math.min(5, Number(slotNumber || 1)));
  const cfg = SLOT_WINDOWS[safeSlot] || SLOT_WINDOWS[1];

  const publishDay = new Date(publishAt);
  publishDay.setHours(0, 0, 0, 0);

  const start = new Date(publishDay);
  start.setDate(start.getDate() + cfg.startDayOffset);
  start.setHours(cfg.startHour, cfg.startMinute, 0, 0);

  const end = new Date(publishDay);
  end.setDate(end.getDate() + cfg.endDayOffset);
  end.setHours(cfg.endHour, cfg.endMinute, 0, 0);
  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }
  return { start, end };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildMinuteKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function distributeInWindow({ events, start, end, seedBase, globalTakenMinuteKeys }) {
  const sorted = events
    .slice()
    .sort((a, b) => hashString(`${seedBase}:${a.channelId}`) - hashString(`${seedBase}:${b.channelId}`));

  const n = sorted.length;
  const startMs = start.getTime();
  const endMs = end.getTime();
  const span = Math.max(60 * 1000, endMs - startMs);
  const step = span / (n + 1);
  const jitterCap = Math.max(90 * 1000, Math.floor(step * 0.35));

  sorted.forEach((event, index) => {
    const anchor = startMs + (step * (index + 1));
    const jitter = seededInt(`${seedBase}:${event.channelId}:jitter`, -jitterCap, jitterCap);
    const boundedMs = clamp(
      Math.floor(anchor + jitter),
      startMs + (60 * 1000),
      endMs - (60 * 1000),
    );
    const dt = new Date(boundedMs);
    dt.setSeconds(seededInt(`${seedBase}:${event.channelId}:sec`, 2, 58), 0);

    let minuteKey = buildMinuteKey(dt);
    let safeGuard = 0;
    while (globalTakenMinuteKeys.has(minuteKey) && safeGuard < 240) {
      dt.setMinutes(dt.getMinutes() + 1);
      if (dt >= end) {
        dt.setMinutes(dt.getMinutes() - 2);
      }
      minuteKey = buildMinuteKey(dt);
      safeGuard += 1;
    }
    globalTakenMinuteKeys.add(minuteKey);
    event.calculatedUploadAt = dt;
  });
}

function isValidUploadBeforePublish(uploadAt, publishAt, minLeadMinutes) {
  if (!uploadAt || !publishAt) return false;
  const leadMs = Math.max(1, Number(minLeadMinutes || 30)) * 60 * 1000;
  return uploadAt.getTime() <= (publishAt.getTime() - leadMs);
}

function prepareHumanizedSlotPlans({
  channelSlotPlans = {},
  channelIds = [],
  now = new Date(),
  minLeadMinutes = 45,
}) {
  const planByChannel = {};
  const groups = new Map();
  const globalTakenMinuteKeys = new Set();

  channelIds.forEach((channelId) => {
    const normalized = normalizeSlotPlan(channelSlotPlans[channelId] || []);
    planByChannel[channelId] = normalized;

    normalized.forEach((slot, index) => {
      const publishAt = ensurePublishDateTime(slot, now);
      const existingUploadAt = parseDateTime(slot.upload_date, slot.upload_time);
      const useExisting = existingUploadAt
        && isValidUploadBeforePublish(existingUploadAt, publishAt, minLeadMinutes);

      if (slot.manual_upload_time && useExisting) {
        const minuteKey = buildMinuteKey(existingUploadAt);
        if (!globalTakenMinuteKeys.has(minuteKey)) {
          globalTakenMinuteKeys.add(minuteKey);
          slot.upload_date = toDateOnly(existingUploadAt);
          slot.upload_time = toTimeOnly(existingUploadAt);
          slot.upload_mode = 'manual';
          slot.upload_at_iso = existingUploadAt.toISOString();
          slot.publish_at_iso = publishAt.toISOString();
          return;
        }
      }

      if (!slot.manual_upload_time && useExisting) {
        const minuteKey = buildMinuteKey(existingUploadAt);
        if (!globalTakenMinuteKeys.has(minuteKey)) {
          globalTakenMinuteKeys.add(minuteKey);
          slot.upload_mode = 'auto';
          slot.upload_at_iso = existingUploadAt.toISOString();
          slot.publish_at_iso = publishAt.toISOString();
          return;
        }
      }

      const key = `${toDateOnly(publishAt)}|${slot.slot_number}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        channelId,
        index,
        slot,
        publishAt,
      });
    });
  });

  groups.forEach((events, key) => {
    if (!events.length) return;
    const publishOrder = events
      .slice()
      .sort((a, b) => hashString(`${key}:publish:${a.channelId}`) - hashString(`${key}:publish:${b.channelId}`));
    let cumulativeDelay = 0;
    publishOrder.forEach((event, idx) => {
      if (idx > 0) {
        cumulativeDelay += seededInt(`${key}:delay:${event.channelId}`, 1, 5);
      }
      event.publishAt = new Date(event.publishAt.getTime() + (cumulativeDelay * 60 * 1000));
      event.slot.date = toDateOnly(event.publishAt);
      event.slot.publish_date = event.slot.date;
      event.slot.time = toTimeOnly(event.publishAt);
      event.slot.publish_time = event.slot.time;
      event.slot.publish_at_iso = event.publishAt.toISOString();
    });

    const publishAt = publishOrder[0].publishAt;
    const slotNumber = publishOrder[0].slot.slot_number;
    const { start, end } = getWindowBounds(publishAt, slotNumber);
    distributeInWindow({
      events,
      start,
      end,
      seedBase: `${key}:${toDateOnly(now)}`,
      globalTakenMinuteKeys,
    });
  });

  channelIds.forEach((channelId) => {
    const plan = Array.isArray(planByChannel[channelId]) ? planByChannel[channelId] : [];
    plan.forEach((slot) => {
      const publishAt = ensurePublishDateTime(slot, now);
      if (slot.upload_at_iso) return;

      const eventFromGroup = [...groups.values()]
        .flat()
        .find((entry) => entry.channelId === channelId && entry.slot.slot_number === slot.slot_number);
      let uploadAt = eventFromGroup?.calculatedUploadAt || null;

      if (!uploadAt || !isValidUploadBeforePublish(uploadAt, publishAt, minLeadMinutes)) {
        const { start, end } = getWindowBounds(publishAt, slot.slot_number);
        uploadAt = getRandomTime(start, end, `${channelId}:${slot.slot_number}:${toDateOnly(publishAt)}`);
        if (!isValidUploadBeforePublish(uploadAt, publishAt, minLeadMinutes)) {
          uploadAt = new Date(publishAt.getTime() - (Math.max(30, Number(minLeadMinutes || 45)) * 60 * 1000));
        }
      }

      if (uploadAt <= now && publishAt > now) {
        const pushMinutes = seededInt(`${channelId}:${slot.slot_number}:${toDateOnly(now)}:push`, 5, 18);
        uploadAt = new Date(now.getTime() + (pushMinutes * 60 * 1000));
      }

      slot.upload_date = toDateOnly(uploadAt);
      slot.upload_time = toTimeOnly(uploadAt);
      slot.upload_at_iso = uploadAt.toISOString();
      slot.publish_at_iso = publishAt.toISOString();
      slot.upload_mode = slot.manual_upload_time ? 'manual' : 'auto';
      slot.auto_upload_enabled = !slot.manual_upload_time;
    });

    const ordered = plan
      .slice()
      .sort((a, b) => {
        const left = parseDateTime(a.upload_date, a.upload_time)?.getTime() || Number.MAX_SAFE_INTEGER;
        const right = parseDateTime(b.upload_date, b.upload_time)?.getTime() || Number.MAX_SAFE_INTEGER;
        return left - right;
      });
    const rankBySlot = new Map();
    ordered.forEach((slot, idx) => rankBySlot.set(String(slot.slot_number), idx + 1));
    planByChannel[channelId] = plan.map((slot) => ({
      ...slot,
      execution_order: rankBySlot.get(String(slot.slot_number)) || 999,
    }));
  });

  return planByChannel;
}

function isSlotDueForUpload(slot, now = new Date()) {
  const uploadAt = parseDateTime(slot?.upload_date, slot?.upload_time);
  if (!uploadAt) return true;
  return uploadAt <= now;
}

module.exports = {
  SLOT_WINDOWS,
  FIXED_PUBLISH_TIMES,
  DAILY_SLOT_PRESETS,
  getSlotNumbersForDailyCount,
  getRandomTime,
  parseDateTime,
  normalizeSlot,
  normalizeSlotPlan,
  prepareHumanizedSlotPlans,
  isSlotDueForUpload,
  toDateOnly,
  toTimeOnly,
};
