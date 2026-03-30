import { computeUploadAtForSchedule, getPublishSlots, validateDistribution } from "../services/humanTiming.js";

function localIso(date: Date, hhmm: string) {
  const [h, m] = hhmm.split(":").map((v) => Number(v));
  const next = new Date(date);
  next.setHours(h, m, 0, 0);
  return next.toISOString();
}

async function main() {
  const channels = 12;
  const slots = getPublishSlots(5);
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 1);
  baseDate.setHours(0, 0, 0, 0);

  const allUploads: string[] = [];
  let delayViolations = 0;
  let windowViolations = 0;
  let clusterViolations = 0;
  const windows: Record<string, { minHours: number; maxHours: number }> = {
    "04:00": { minHours: 10, maxHours: 13 },
    "07:00": { minHours: 10, maxHours: 12 },
    "13:00": { minHours: 13, maxHours: 15 },
    "17:00": { minHours: 14, maxHours: 16 },
    "22:00": { minHours: 16, maxHours: 18 },
  };

  for (const slot of slots) {
    const publishAt = localIso(baseDate, slot);
    const uploadsForSlot: string[] = [];
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const uploadAt = computeUploadAtForSchedule(publishAt, channelIndex, channels);
      uploadsForSlot.push(uploadAt);
      allUploads.push(uploadAt);
    }
    const sorted = uploadsForSlot.map((v) => new Date(v).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      const diffMin = Math.floor((sorted[i] - sorted[i - 1]) / 60_000);
      if (diffMin < 1) {
        delayViolations += 1;
      }
    }
    const publishTs = new Date(publishAt).getTime();
    for (const uploadAt of uploadsForSlot) {
      const gapHours = (publishTs - new Date(uploadAt).getTime()) / (60 * 60 * 1000);
      const expected = windows[slot];
      if (!expected || gapHours < expected.minHours || gapHours > expected.maxHours) {
        windowViolations += 1;
      }
    }
    const spread = validateDistribution(uploadsForSlot);
    if (spread.clustered) {
      clusterViolations += 1;
    }
  }

  const spread = validateDistribution(allUploads);
  const output = {
    channels,
    slots: slots.length,
    generatedUploads: allUploads.length,
    delayViolations,
    windowViolations,
    clusterViolations,
    minGapMs: spread.minGapMs,
    clustered: clusterViolations > 0,
  };
  console.log(JSON.stringify(output, null, 2));
  if (delayViolations > 0 || windowViolations > 0 || clusterViolations > 0) {
    throw new Error("Human timing validation failed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
