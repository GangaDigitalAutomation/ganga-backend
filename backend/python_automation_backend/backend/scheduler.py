from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from backend.config import AppConfig, build_slots_for_ui


@dataclass(frozen=True)
class ScheduledSlot:
    slot_index: int
    publish_at_utc: str
    publish_at_local_hhmm: str


class Scheduler:
    def __init__(self, config: AppConfig):
        self.config = config
        self._base_slots = [item["time"] for item in build_slots_for_ui(config)]

    def _tomorrow_utc_date(self) -> date:
        now = datetime.now(timezone.utc)
        return (now + timedelta(days=1)).date()

    def _parse_hhmm(self, hhmm: str) -> tuple[int, int]:
        hh, mm = hhmm.split(":")
        return int(hh), int(mm)

    def compute_slot(self, *, channel_index: int, slot_index: int) -> ScheduledSlot:
        # Today run schedules for tomorrow (T+1).
        # Channel offsets avoid same-time scheduling across channels.
        target_day = self._tomorrow_utc_date()
        base_hhmm = self._base_slots[min(slot_index, len(self._base_slots) - 1)]
        hour, minute = self._parse_hhmm(base_hhmm)

        base_dt = datetime.combine(target_day, time(hour=hour, minute=minute, tzinfo=timezone.utc))
        offset_minutes = channel_index * self.config.channel_delay_minutes
        publish_dt = base_dt + timedelta(minutes=offset_minutes)

        return ScheduledSlot(
            slot_index=slot_index + 1,
            publish_at_utc=publish_dt.isoformat().replace("+00:00", "Z"),
            publish_at_local_hhmm=f"{publish_dt.hour:02d}:{publish_dt.minute:02d}",
        )

    def slots_for_ui(self) -> list[dict[str, str | int]]:
        rows: list[dict[str, str | int]] = []
        target_day = self._tomorrow_utc_date().isoformat()
        for idx, hhmm in enumerate(self._base_slots):
            rows.append(
                {
                    "slot": idx + 1,
                    "date": target_day,
                    "time": hhmm,
                }
            )
        return rows
