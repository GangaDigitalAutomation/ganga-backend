from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from tracker import UploadTracker


DAILY_QUOTA_LIMIT = 10_000
UPLOAD_UNITS = 1_600
MAX_DAILY_UPLOADS = 5


@dataclass
class ChannelQuota:
    channel_id: str
    used_units: int
    remaining_units: int
    uploads_today: int
    remaining_uploads: int
    window_started_at: str
    resets_at: str


class QuotaManager:
    def __init__(self, tracker: UploadTracker) -> None:
        self.tracker = tracker

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _ensure_channel_quota(self, data: dict[str, Any], channel_id: str) -> dict[str, Any]:
        by_channel = data.setdefault("quota", {}).setdefault("by_channel", {})
        existing = by_channel.get(channel_id)
        now = self._now()
        if not existing:
            existing = {
                "window_started_at": now.isoformat(),
                "used_units": 0,
                "uploads_today": 0,
            }
            by_channel[channel_id] = existing
        return existing

    def _apply_reset_if_needed(self, quota: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        now = self._now()
        started = datetime.fromisoformat(str(quota.get("window_started_at")))
        reset_due = now >= started + timedelta(hours=24)
        if reset_due:
            quota["window_started_at"] = now.isoformat()
            quota["used_units"] = 0
            quota["uploads_today"] = 0
        return quota, reset_due

    def status(self, channel_id: str) -> ChannelQuota:
        payload = self.tracker.read()
        quota = self._ensure_channel_quota(payload, channel_id)
        quota, _ = self._apply_reset_if_needed(quota)

        used = int(quota.get("used_units", 0))
        uploads = int(quota.get("uploads_today", 0))
        started = datetime.fromisoformat(str(quota.get("window_started_at")))
        resets_at = started + timedelta(hours=24)

        remaining_units = max(0, DAILY_QUOTA_LIMIT - used)
        remaining_uploads = max(0, MAX_DAILY_UPLOADS - uploads)

        return ChannelQuota(
            channel_id=channel_id,
            used_units=used,
            remaining_units=remaining_units,
            uploads_today=uploads,
            remaining_uploads=remaining_uploads,
            window_started_at=started.isoformat(),
            resets_at=resets_at.isoformat(),
        )

    def can_upload(self, channel_id: str, units: int = UPLOAD_UNITS) -> tuple[bool, ChannelQuota]:
        state = self.status(channel_id)
        allowed = state.remaining_units >= units and state.remaining_uploads > 0
        return allowed, state

    def consume(self, channel_id: str, units: int = UPLOAD_UNITS) -> ChannelQuota:
        now = self._now().isoformat()

        def _mutate(data: dict[str, Any]) -> ChannelQuota:
            quota = self._ensure_channel_quota(data, channel_id)
            quota, was_reset = self._apply_reset_if_needed(quota)
            quota["used_units"] = int(quota.get("used_units", 0)) + units
            quota["uploads_today"] = int(quota.get("uploads_today", 0)) + 1
            if was_reset:
                data.setdefault("runtime", {})["last_quota_refresh_at"] = now
            used = int(quota.get("used_units", 0))
            uploads = int(quota.get("uploads_today", 0))
            started = datetime.fromisoformat(str(quota.get("window_started_at")))
            return ChannelQuota(
                channel_id=channel_id,
                used_units=used,
                remaining_units=max(0, DAILY_QUOTA_LIMIT - used),
                uploads_today=uploads,
                remaining_uploads=max(0, MAX_DAILY_UPLOADS - uploads),
                window_started_at=started.isoformat(),
                resets_at=(started + timedelta(hours=24)).isoformat(),
            )

        return self.tracker.mutate(_mutate)

    def check_and_mark_resets(self) -> list[str]:
        refreshed_channels: list[str] = []
        now = self._now().isoformat()

        def _mutate(data: dict[str, Any]) -> None:
            by_channel = data.setdefault("quota", {}).setdefault("by_channel", {})
            for channel_id, quota in by_channel.items():
                _, reset = self._apply_reset_if_needed(quota)
                if reset:
                    refreshed_channels.append(channel_id)
            if refreshed_channels:
                data.setdefault("runtime", {})["last_quota_refresh_at"] = now

        self.tracker.mutate(_mutate)
        return refreshed_channels
