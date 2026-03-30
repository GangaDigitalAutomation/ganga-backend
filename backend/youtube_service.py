from __future__ import annotations

import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from token_service import build_google_credentials, ChannelCredentials


@dataclass
class UploadResult:
    youtube_video_id: str
    attempts: int


def _is_retryable_error(error: Exception) -> bool:
    if isinstance(error, HttpError):
        return int(error.status_code) in {408, 429, 500, 502, 503, 504}

    message = str(error).lower()
    retry_markers = [
        "connection reset",
        "econnreset",
        "timed out",
        "timeout",
        "temporarily unavailable",
        "socket hang up",
    ]
    return any(marker in message for marker in retry_markers)


def upload_video_resumable(
    channel: ChannelCredentials,
    file_path: Path,
    *,
    title: str,
    description: str,
    tags: list[str] | None,
    publish_at_iso: str,
    mime_type: str,
    max_retries: int = 3,
) -> UploadResult:
    creds = build_google_credentials(channel)
    youtube = build("youtube", "v3", credentials=creds, cache_discovery=False)

    metadata = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags or [],
        },
        "status": {
            "privacyStatus": "private",
            "publishAt": publish_at_iso,
            "selfDeclaredMadeForKids": False,
        },
    }

    media = MediaFileUpload(
        str(file_path),
        mimetype=mime_type,
        resumable=True,
        chunksize=8 * 1024 * 1024,
    )

    attempt = 0
    while True:
        attempt += 1
        try:
            request = youtube.videos().insert(
                part="snippet,status",
                body=metadata,
                media_body=media,
            )

            response: dict[str, Any] | None = None
            while response is None:
                _status, response = request.next_chunk(num_retries=0)

            video_id = str(response.get("id") or "").strip()
            if not video_id:
                raise RuntimeError("YouTube response did not include video id")

            return UploadResult(youtube_video_id=video_id, attempts=attempt)
        except Exception as error:
            if attempt >= max_retries or not _is_retryable_error(error):
                raise
            delay = min(20, (2 ** (attempt - 1)) + random.uniform(0.2, 0.8))
            time.sleep(delay)
