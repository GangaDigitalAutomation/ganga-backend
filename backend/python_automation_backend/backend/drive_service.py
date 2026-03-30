from dataclasses import dataclass
from typing import Any

import requests

from backend.config import AppConfig


@dataclass
class DriveVideo:
    file_id: str
    name: str
    size: int
    folder_id: str


class DriveService:
    def __init__(self, config: AppConfig):
        self.config = config

    def _is_video(self, name: str, mime_type: str) -> bool:
        n = (name or "").lower()
        m = (mime_type or "").lower()
        return (
            n.endswith(".mp4")
            or n.endswith(".mov")
            or n.endswith(".mkv")
            or n.endswith(".avi")
            or m in {"video/mp4", "video/quicktime", "video/x-matroska", "video/x-msvideo"}
        )

    def fetch_folder_videos(self, folder_id: str, access_token: str) -> list[DriveVideo]:
        if not access_token:
            raise RuntimeError("Missing access token for Drive API.")
        videos: list[DriveVideo] = []
        page_token = None
        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed=false",
                "fields": "nextPageToken,files(id,name,size,mimeType)",
                "pageSize": 1000,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token

            response = requests.get(
                "https://www.googleapis.com/drive/v3/files",
                params=params,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=30,
            )
            try:
                response.raise_for_status()
            except requests.HTTPError as error:
                text = (response.text or "")
                if "insufficientPermissions" in text or "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in text:
                    print("ERROR: Missing Drive Scope. Reconnect required.")
                raise error
            payload: dict[str, Any] = response.json()
            for item in payload.get("files", []):
                name = str(item.get("name", "")).strip()
                mime_type = str(item.get("mimeType", "")).strip()
                if not self._is_video(name, mime_type):
                    continue
                videos.append(
                    DriveVideo(
                        file_id=str(item.get("id", "")).strip(),
                        name=name,
                        size=int(item.get("size", 0) or 0),
                        folder_id=folder_id,
                    )
                )

            page_token = payload.get("nextPageToken")
            if not page_token:
                break

        return videos

    def fetch_all_videos(self, folder_ids: list[str], access_token: str) -> list[DriveVideo]:
        all_videos: list[DriveVideo] = []
        for folder_id in folder_ids:
            all_videos.extend(self.fetch_folder_videos(folder_id, access_token))
        return all_videos
