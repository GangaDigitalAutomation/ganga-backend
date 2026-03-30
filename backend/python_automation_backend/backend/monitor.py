import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Monitor:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._save(
                {
                    "updated_at": _utc_now(),
                    "quota": {},
                    "channels": {},
                    "logs": [],
                    "notification": None,
                }
            )

    def _load(self) -> dict[str, Any]:
        raw = self.path.read_text(encoding="utf-8") or "{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {}
        data.setdefault("quota", {})
        data.setdefault("channels", {})
        data.setdefault("logs", [])
        data.setdefault("notification", None)
        return data

    def _save(self, data: dict[str, Any]) -> None:
        data["updated_at"] = _utc_now()
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def add_log(self, message: str) -> None:
        data = self._load()
        logs = data.setdefault("logs", [])
        logs.append({"time": _utc_now(), "message": message})
        # Keep latest 300 messages for UI polling
        if len(logs) > 300:
            del logs[:-300]
        self._save(data)

    def set_notification(self, message: str | None) -> None:
        data = self._load()
        data["notification"] = message
        self._save(data)

    def set_quota(self, channel_id: str, *, total: int, used: int, remaining: int, reset_at: str) -> None:
        data = self._load()
        data["quota"][channel_id] = {
            "total": total,
            "used": used,
            "remaining": remaining,
            "reset_at": reset_at,
            "updated_at": _utc_now(),
        }
        self._save(data)

    def set_channel_status(
        self,
        channel_id: str,
        *,
        status: str,
        video_name: str | None = None,
        youtube_video_id: str | None = None,
        error: str | None = None,
    ) -> None:
        data = self._load()
        data["channels"][channel_id] = {
            "status": status,
            "video_name": video_name,
            "youtube_video_id": youtube_video_id,
            "error": error,
            "updated_at": _utc_now(),
        }
        self._save(data)

    def snapshot(self) -> dict[str, Any]:
        return self._load()
