from dataclasses import dataclass
import json
from typing import Any

import requests

from backend.config import AppConfig


@dataclass
class ChannelToken:
    channel_id: str
    access_token: str
    refresh_token: str


class TokenService:
    def __init__(self, config: AppConfig):
        self.config = config

    def _parse_channel_tokens_payload(self, payload: dict[str, Any]) -> list[ChannelToken]:
        channels = payload.get("channels", [])
        tokens: list[ChannelToken] = []
        for item in channels:
            channel_id = str(item.get("channel_id", "")).strip()
            access_token = str(item.get("access_token", "")).strip()
            refresh_token = str(item.get("refresh_token", "")).strip()
            if not channel_id or not refresh_token:
                continue
            tokens.append(
                ChannelToken(
                    channel_id=channel_id,
                    access_token=access_token,
                    refresh_token=refresh_token,
                )
            )
        return tokens

    def fetch_channel_tokens(self) -> list[ChannelToken]:
        if self.config.token_api_url:
            response = requests.get(
                self.config.token_api_url,
                timeout=self.config.token_api_timeout_sec,
            )
            response.raise_for_status()
            payload: dict[str, Any] = response.json()
            return self._parse_channel_tokens_payload(payload)

        if self.config.tokens_json:
            try:
                payload = json.loads(self.config.tokens_json)
            except json.JSONDecodeError as exc:
                raise RuntimeError("TOKENS_JSON is invalid JSON.") from exc
            if not isinstance(payload, dict):
                raise RuntimeError("TOKENS_JSON must be a JSON object with 'channels'.")
            return self._parse_channel_tokens_payload(payload)

        return []

    def refresh_access_token(self, refresh_token: str) -> str:
        if not self.config.youtube_client_id or not self.config.youtube_client_secret:
            raise RuntimeError("Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET for token refresh.")

        response = requests.post(
            self.config.youtube_token_uri,
            timeout=self.config.token_api_timeout_sec,
            data={
                "client_id": self.config.youtube_client_id,
                "client_secret": self.config.youtube_client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        payload = response.json()
        access_token = str(payload.get("access_token", "")).strip()
        if not access_token:
            raise RuntimeError("Token refresh did not return an access token.")
        return access_token
