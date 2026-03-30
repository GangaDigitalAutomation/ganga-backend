import mimetypes
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from backend.config import AppConfig


class YouTubeService:
    def __init__(self, config: AppConfig):
        self.config = config

    def _build_credentials(self, *, access_token: str, refresh_token: str) -> Credentials:
        return Credentials(
            token=access_token,
            refresh_token=refresh_token,
            token_uri=self.config.youtube_token_uri,
            client_id=self.config.youtube_client_id or None,
            client_secret=self.config.youtube_client_secret or None,
            scopes=[
                "https://www.googleapis.com/auth/youtube.upload",
                "https://www.googleapis.com/auth/drive.readonly",
            ],
        )

    def upload_video(
        self,
        *,
        access_token: str,
        refresh_token: str,
        file_path: Path,
        title: str,
        description: str,
        tags: list[str],
        publish_at: str,
    ) -> str:
        if not file_path.exists():
            raise RuntimeError(f"Upload file not found: {file_path}")

        print("Using Access Token:", access_token)
        print("Uploading to YouTube...")
        guessed_mime = mimetypes.guess_type(str(file_path))[0] or "video/mp4"
        credentials = self._build_credentials(access_token=access_token, refresh_token=refresh_token)
        youtube = build("youtube", "v3", credentials=credentials, cache_discovery=False)

        request = youtube.videos().insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": title,
                    "description": description,
                    "tags": tags,
                },
                "status": {
                    # Scheduled publish requires private + publishAt.
                    "privacyStatus": "private",
                    "publishAt": publish_at,
                    "selfDeclaredMadeForKids": False,
                },
            },
            media_body=MediaFileUpload(
                str(file_path),
                mimetype=guessed_mime,
                chunksize=8 * 1024 * 1024,
                resumable=True,
            ),
        )

        response = None
        while response is None:
            _, response = request.next_chunk()

        video_id = str(response.get("id", "")).strip()
        if not video_id:
            raise RuntimeError("YouTube upload completed without video id.")
        return video_id
