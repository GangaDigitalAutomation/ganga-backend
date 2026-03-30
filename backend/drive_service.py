from __future__ import annotations

import re
from pathlib import Path

import requests

from token_service import build_google_credentials, ChannelCredentials


def parse_drive_file_id(link_or_id: str) -> str:
    raw = str(link_or_id or "").strip()
    if not raw:
        return ""

    if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", raw):
        return raw

    direct = re.search(r"/d/([a-zA-Z0-9_-]+)", raw)
    if direct:
        return direct.group(1)

    query = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", raw)
    if query:
        return query.group(1)

    return ""


def download_from_drive(channel: ChannelCredentials, drive_file_id: str, output_path: Path, timeout_sec: int = 120) -> Path:
    file_id = parse_drive_file_id(drive_file_id)
    if not file_id:
        raise ValueError(f"Invalid Drive file id/link: {drive_file_id}")

    creds = build_google_credentials(channel)
    if not creds.token:
        raise RuntimeError("Google credentials refresh failed: no access token")

    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    headers = {"Authorization": f"Bearer {creds.token}"}

    with requests.get(url, headers=headers, stream=True, timeout=timeout_sec) as response:
        response.raise_for_status()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)

    return output_path
