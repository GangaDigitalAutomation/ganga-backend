import os
import tempfile
from pathlib import Path

import requests

from backend.config import AppConfig


class DriveDownloader:
    def __init__(self, config: AppConfig):
        self.config = config

    def download_video(self, file_id: str, name: str, access_token: str) -> Path:
        if not access_token:
            raise RuntimeError("Missing access token for Drive download.")
        suffix = Path(name).suffix or ".mp4"
        fd, temp_path = tempfile.mkstemp(prefix=f"gda-{file_id}-", suffix=suffix)
        os.close(fd)

        print("Downloading from Drive...")
        response = requests.get(
            "https://www.googleapis.com/drive/v3/files/" + file_id,
            params={"alt": "media"},
            headers={"Authorization": f"Bearer {access_token}"},
            stream=True,
            timeout=120,
        )
        try:
            response.raise_for_status()
        except requests.HTTPError as error:
            text = (response.text or "")
            if "insufficientPermissions" in text or "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in text:
                print("ERROR: Missing Drive Scope. Reconnect required.")
            raise error

        with open(temp_path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)

        return Path(temp_path)
