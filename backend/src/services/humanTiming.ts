import { randomInt } from "node:crypto";

export type SlotPublishTime = "04:00" | "07:00" | "13:00" | "17:00" | "22:00";

const SLOT_TIMESET: Record<number, SlotPublishTime[]> = {
  1: ["22:00"],
  2: ["04:00", "22:00"],
  3: ["04:00", "17:00", "22:00"],
  4: ["04:00", "07:00", "17:00", "22:00"],
  5: ["04:00", "07:00", "13:00", "17:00", "22:00"],
};

const UPLOAD_WINDOWS: Record<
  SlotPublishTime,
  { startHour: number; startMinute: number; endHour: number; endMinute: number; previousDay: boolean }
> = {
  "04:00": { startHour: 15, startMinute: 0, endHour: 18, endMinute: 0, previousDay: true },
  "07:00": { startHour: 19, startMinute: 0, endHour: 21, endMinute: 0, previousDay: true },
  "13:00": { startHour: 22, startMinute: 0, endHour: 0, endMinute: 0, previousDay: true },
  "17:00": { startHour: 1, startMinute: 0, endHour: 3, endMinute: 0, previousDay: false },
  "22:00": { startHour: 4, startMinute: 0, endHour: 6, endMinute: 0, previousDay: false },
};

export function getPublishSlots(videosPerDay: number): SlotPublishTime[] {
  const safeCount = Math.max(1, Math.min(5, Math.floor(videosPerDay)));
  return SLOT_TIMESET[safeCount];
}

export function computePublishDelayMinutes(channelIndex: number) {
  if (channelIndex <= 0) return 0;
  const min = channelIndex;
  const max = channelIndex + 4;
  return randomInt(min, max + 1);
}

export function computePublishDelaySeries(channelCount: number) {
  const delays: number[] = [];
  for (let index = 0; index < channelCount; index += 1) {
    if (index === 0) {
      delays.push(0);
      continue;
    }
    const min = index;
    const max = index + 4;
    const previous = delays[index - 1];
    const safeMin = Math.max(min, previous + 1);
    delays.push(randomInt(safeMin, max + 1));
  }
  return delays;
}

export function computeUploadAtForSchedule(
  publishAtIso: string,
  channelIndex: number,
  channelCount: number,
) {
  const publish = new Date(publishAtIso);
  const hhmm = `${String(publish.getHours()).padStart(2, "0")}:${String(publish.getMinutes()).padStart(2, "0")}`;
  const slotKey = (Object.keys(UPLOAD_WINDOWS) as SlotPublishTime[]).includes(hhmm as SlotPublishTime)
    ? (hhmm as SlotPublishTime)
    : null;

  if (!slotKey) {
    const fallback = new Date(publish.getTime() - randomInt(2, 14) * 60 * 60 * 1000);
    return fallback.toISOString();
  }

  const window = UPLOAD_WINDOWS[slotKey];
  const startDate = new Date(publish);
  if (window.previousDay) startDate.setDate(startDate.getDate() - 1);
  startDate.setHours(window.startHour % 24, window.startMinute, 0, 0);

  const endDate = new Date(publish);
  if (window.previousDay) endDate.setDate(endDate.getDate() - 1);
  endDate.setHours(window.endHour % 24, window.endMinute, 0, 0);
  if (window.endHour < window.startHour || (window.endHour === window.startHour && window.endMinute <= window.startMinute)) {
    endDate.setDate(endDate.getDate() + 1);
  }

  const start = startDate.getTime();
  const end = endDate.getTime();
  const span = Math.max(60_000, end - start);
  const bucket = span / Math.max(channelCount, 1);
  const bucketStart = start + Math.floor(bucket * channelIndex);
  const bucketEnd = channelIndex >= channelCount - 1 ? end : Math.min(end, bucketStart + Math.floor(bucket));
  const safeStart = Math.min(bucketEnd - 1, bucketStart + 60_000);
  const safeEnd = Math.max(safeStart + 1, bucketEnd - 60_000);
  const raw = randomInt(safeStart, safeEnd + 1);
  return new Date(raw).toISOString();
}

export function validateDistribution(timesIso: string[]) {
  const times = timesIso.map((value) => new Date(value).getTime()).sort((a, b) => a - b);
  if (times.length < 3) {
    return { minGapMs: 0, clustered: false };
  }
  let minGapMs = Number.MAX_SAFE_INTEGER;
  for (let i = 1; i < times.length; i += 1) {
    minGapMs = Math.min(minGapMs, times[i] - times[i - 1]);
  }
  return {
    minGapMs,
    clustered: minGapMs < 30_000,
  };
}
