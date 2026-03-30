import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class UploadTracker:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._save({"uploads": []})

    def _load(self) -> dict[str, Any]:
        raw = self.path.read_text(encoding="utf-8") or "{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {}
        data.setdefault("uploads", [])
        return data

    def _save(self, data: dict[str, Any]) -> None:
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def is_uploaded(self, channel_id: str, drive_file_id: str) -> bool:
        uploads = self._load().get("uploads", [])
        return any(
            row.get("channel_id") == channel_id and row.get("drive_file_id") == drive_file_id
            for row in uploads
        )

    def mark_uploaded(
        self,
        *,
        channel_id: str,
        drive_file_id: str,
        youtube_video_id: str,
        publish_at: str,
        title: str,
    ) -> None:
        data = self._load()
        uploads: list[dict[str, Any]] = data.setdefault("uploads", [])
        uploads.append(
            {
                "channel_id": channel_id,
                "drive_file_id": drive_file_id,
                "youtube_video_id": youtube_video_id,
                "title": title,
                "publish_at": publish_at,
                "upload_date": _utc_now()[:10],
                "uploaded_at": _utc_now(),
            }
        )
        self._save(data)
