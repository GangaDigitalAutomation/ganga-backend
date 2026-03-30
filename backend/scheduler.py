from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any


@dataclass
class ScheduledItem:
    channel_id: str
    video_id: str
    publish_at_iso: str
    slot_time: str
    slot_date: str


def _format_time(hour: int, minute: int) -> str:
    return f"{hour:02d}:{minute:02d}"


def generate_default_slot_times(videos_per_day: int) -> list[str]:
    safe = max(1, min(5, int(videos_per_day)))
    presets = {
        1: ["16:00"],
        2: ["10:00", "16:00"],
        3: ["08:00", "12:00", "16:00"],
        4: ["08:00", "11:00", "14:00", "16:00"],
        5: ["08:00", "10:00", "12:00", "14:00", "16:00"],
    }
    return presets[safe]


def tomorrow_local(now: datetime | None = None) -> datetime:
    value = now or datetime.now()
    t = value + timedelta(days=1)
    return datetime(t.year, t.month, t.day)


def next_run_after_tomorrow(now: datetime | None = None) -> datetime:
    value = now or datetime.now()
    t = value + timedelta(days=2)
    return datetime(t.year, t.month, t.day, 0, 5, 0)


def build_smart_schedule(
    *,
    channels: list[dict[str, Any]],
    videos_by_channel: dict[str, list[dict[str, Any]]],
    videos_per_day: int,
    base_hour: int = 16,
    base_minute: int = 0,
    channel_gap_minutes: int = 2,
) -> list[ScheduledItem]:
    items: list[ScheduledItem] = []
    day = tomorrow_local()
    slot_times = generate_default_slot_times(videos_per_day)

    for channel_index, channel in enumerate(channels):
        channel_id = str(channel.get("id") or "")
        queue = videos_by_channel.get(channel_id, [])
        if not channel_id or not queue:
            continue

        for i, video in enumerate(queue[: max(1, min(5, videos_per_day))]):
            base_slot = slot_times[i] if i < len(slot_times) else _format_time(base_hour, base_minute)
            hh, mm = [int(x) for x in base_slot.split(":", 1)]
            dt = datetime(day.year, day.month, day.day, hh, mm)
            dt = dt + timedelta(minutes=channel_index * max(2, channel_gap_minutes))

            items.append(
                ScheduledItem(
                    channel_id=channel_id,
                    video_id=str(video.get("video_id") or video.get("id") or ""),
                    publish_at_iso=dt.isoformat(),
                    slot_time=_format_time(dt.hour, dt.minute),
                    slot_date=dt.date().isoformat(),
                )
            )

    return items


def build_automation_slots_payload(
    *,
    channels: list[dict[str, Any]],
    videos: list[dict[str, Any]],
    videos_per_day: int,
) -> dict[str, Any]:
    slot_times = generate_default_slot_times(videos_per_day)
    base_date = tomorrow_local().date().isoformat()
    result: dict[str, Any] = {"channels": []}

    for channel in channels:
        channel_id = str(channel.get("id") or "")
        channel_videos = [v for v in videos if str(v.get("channel_id") or channel_id) == channel_id]
        slots = []
        for idx in range(max(1, min(5, videos_per_day))):
            time_value = slot_times[idx] if idx < len(slot_times) else slot_times[-1]
            slots.append(
                {
                    "slot_index": idx,
                    "date": base_date,
                    "time": time_value,
                    "video_options": [
                        {
                            "video_id": str(v.get("video_id") or v.get("id") or ""),
                            "title": str(v.get("title") or "Untitled Video"),
                        }
                        for v in channel_videos
                    ],
                    "selected_video_id": str(channel_videos[idx].get("video_id") or channel_videos[idx].get("id")) if idx < len(channel_videos) else None,
                }
            )
        result["channels"].append(
            {
                "channel_id": channel_id,
                "channel_name": str(channel.get("channel_name") or channel.get("name") or channel_id),
                "slots": slots,
            }
        )

    return result
