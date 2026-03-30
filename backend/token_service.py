from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials


@dataclass
class ChannelCredentials:
    channel_id: str
    channel_name: str
    access_token: str | None
    refresh_token: str
    client_id: str
    client_secret: str
    token_uri: str


def from_channel_record(channel: dict[str, Any]) -> ChannelCredentials:
    refresh_token = str(channel.get("refresh_token") or "").strip()
    client_id = str(channel.get("client_id") or "").strip()
    client_secret = str(channel.get("client_secret") or "").strip()
    if not refresh_token or not client_id or not client_secret:
        raise ValueError(
            f"Channel {channel.get('id')} missing refresh_token/client_id/client_secret"
        )

    return ChannelCredentials(
        channel_id=str(channel.get("id") or ""),
        channel_name=str(channel.get("channel_name") or channel.get("name") or "Unnamed Channel"),
        access_token=str(channel.get("access_token") or "").strip() or None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri=str(channel.get("token_uri") or "https://oauth2.googleapis.com/token"),
    )


def build_google_credentials(channel: ChannelCredentials) -> Credentials:
    creds = Credentials(
        token=channel.access_token,
        refresh_token=channel.refresh_token,
        token_uri=channel.token_uri,
        client_id=channel.client_id,
        client_secret=channel.client_secret,
        scopes=[
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/drive.readonly",
        ],
    )

    if not creds.valid:
        creds.refresh(Request())

    return creds


def build_expiry_iso(hours: int = 1) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()
