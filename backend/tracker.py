from __future__ import annotations

import json
import threading
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class UploadTracker:
    def __init__(self, data_path: Path) -> None:
        self.data_path = data_path
        self._lock = threading.Lock()
        self._bootstrap()

    def _bootstrap(self) -> None:
        self.data_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.data_path.exists():
            self.write(
                {
                    "channels": [],
                    "video_queue": [],
                    "uploads": [],
                    "quota": {"by_channel": {}},
                    "runtime": {
                        "last_run_at": None,
                        "next_run_at": None,
                        "last_quota_refresh_at": None,
                    },
                    "logs": [],
                }
            )

    def read(self) -> dict[str, Any]:
        with self._lock:
            raw = self.data_path.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
            data.setdefault("channels", [])
            data.setdefault("video_queue", [])
            data.setdefault("uploads", [])
            data.setdefault("quota", {"by_channel": {}})
            data.setdefault("runtime", {})
            data.setdefault("logs", [])
            data["quota"].setdefault("by_channel", {})
            return data

    def write(self, data: dict[str, Any]) -> None:
        with self._lock:
            self.data_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def mutate(self, mutator):
        with self._lock:
            raw = self.data_path.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
            data.setdefault("channels", [])
            data.setdefault("video_queue", [])
            data.setdefault("uploads", [])
            data.setdefault("quota", {"by_channel": {}})
            data.setdefault("runtime", {})
            data.setdefault("logs", [])
            data["quota"].setdefault("by_channel", {})

            result = mutator(data)
            self.data_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return result

    def append_log(self, level: str, message: str, **extra: Any) -> None:
        now = datetime.now(timezone.utc).isoformat()

        def _mutate(data: dict[str, Any]) -> None:
            entry = {"at": now, "level": level, "message": message, **extra}
            logs = data.setdefault("logs", [])
            logs.append(entry)
            # Keep only recent logs to avoid unbounded file growth.
            if len(logs) > 2000:
                del logs[:-2000]

        self.mutate(_mutate)

    def has_duplicate_upload(self, channel_id: str, video_id: str, publish_date: str) -> bool:
        data = self.read()
        for item in data.get("uploads", []):
            if (
                str(item.get("channel_id")) == channel_id
                and str(item.get("video_id")) == video_id
                and str(item.get("publish_date")) == publish_date
            ):
                return True
        return False

    def mark_video_status(
        self,
        video_id: str,
        channel_id: str,
        status: str,
        *,
        error: str | None = None,
        youtube_video_id: str | None = None,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()

        def _mutate(data: dict[str, Any]) -> None:
            for video in data.get("video_queue", []):
                if str(video.get("video_id")) == video_id and str(video.get("channel_id")) == channel_id:
                    video["status"] = status
                    video["updated_at"] = now
                    if error:
                        video["last_error"] = error
                    if youtube_video_id:
                        video["youtube_video_id"] = youtube_video_id

        self.mutate(_mutate)

    def add_upload_record(
        self,
        *,
        channel_id: str,
        video_id: str,
        publish_at: str,
        youtube_video_id: str,
        quota_units: int,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        publish_date = publish_at.split("T", 1)[0]

        def _mutate(data: dict[str, Any]) -> None:
            data.setdefault("uploads", []).append(
                {
                    "uploaded_at": now,
                    "channel_id": channel_id,
                    "video_id": video_id,
                    "publish_at": publish_at,
                    "publish_date": publish_date,
                    "youtube_video_id": youtube_video_id,
                    "quota_units": quota_units,
                }
            )

        self.mutate(_mutate)

    def set_runtime(self, *, last_run_at: str | None = None, next_run_at: str | None = None, quota_refresh_at: str | None = None) -> None:
        def _mutate(data: dict[str, Any]) -> None:
            runtime = data.setdefault("runtime", {})
            if last_run_at is not None:
                runtime["last_run_at"] = last_run_at
            if next_run_at is not None:
                runtime["next_run_at"] = next_run_at
            if quota_refresh_at is not None:
                runtime["last_quota_refresh_at"] = quota_refresh_at

        self.mutate(_mutate)

    def deep_copy(self) -> dict[str, Any]:
        return deepcopy(self.read())
