import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _day_key(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


@dataclass(frozen=True)
class ChannelQuota:
    channel_id: str
    total: int
    used: int
    remaining: int
    upload_cost: int
    resets_at: str
    date_key: str


class QuotaManager:
    def __init__(self, path: Path, *, quota_total: int, upload_cost: int):
        self.path = path
        self.quota_total = quota_total
        self.upload_cost = upload_cost
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._save({"channels": {}})

    def _load(self) -> dict[str, Any]:
        raw = self.path.read_text(encoding="utf-8") or "{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {}
        data.setdefault("channels", {})
        return data

    def _save(self, data: dict[str, Any]) -> None:
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def get_channel_quota(self, channel_id: str) -> tuple[ChannelQuota, bool]:
        data = self._load()
        channels = data.setdefault("channels", {})
        now = _utc_now()
        today = _day_key(now)
        record = channels.get(channel_id, {})
        previous_day = str(record.get("date", "")).strip()
        used = int(record.get("used", 0) or 0)

        refreshed = previous_day != today
        if refreshed:
            used = 0

        used = max(0, min(used, self.quota_total))
        channels[channel_id] = {"date": today, "used": used}
        self._save(data)

        reset_at = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
        remaining = max(0, self.quota_total - used)
        return (
            ChannelQuota(
                channel_id=channel_id,
                total=self.quota_total,
                used=used,
                remaining=remaining,
                upload_cost=self.upload_cost,
                resets_at=reset_at.isoformat(),
                date_key=today,
            ),
            refreshed,
        )

    def can_upload_count(self, channel_id: str, max_count_by_config: int) -> int:
        quota, _ = self.get_channel_quota(channel_id)
        by_quota = quota.remaining // quota.upload_cost
        return max(0, min(max_count_by_config, by_quota))

    def consume_upload(self, channel_id: str, uploads_count: int = 1) -> ChannelQuota:
        if uploads_count <= 0:
            quota, _ = self.get_channel_quota(channel_id)
            return quota

        data = self._load()
        channels = data.setdefault("channels", {})
        now = _utc_now()
        today = _day_key(now)
        record = channels.get(channel_id, {})
        if str(record.get("date", "")).strip() != today:
            record = {"date": today, "used": 0}

        used = int(record.get("used", 0) or 0) + (uploads_count * self.upload_cost)
        used = max(0, min(used, self.quota_total))
        channels[channel_id] = {"date": today, "used": used}
        self._save(data)

        remaining = max(0, self.quota_total - used)
        reset_at = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
        return ChannelQuota(
            channel_id=channel_id,
            total=self.quota_total,
            used=used,
            remaining=remaining,
            upload_cost=self.upload_cost,
            resets_at=reset_at.isoformat(),
            date_key=today,
        )
