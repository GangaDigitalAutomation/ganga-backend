import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class AppConfig:
    videos_per_day: int
    titles: list[str]
    description: str
    tags: list[str]
    drive_folder_ids: list[str]
    drive_api_key: str
    token_api_url: str
    tokens_json: str
    token_api_timeout_sec: int
    youtube_client_id: str
    youtube_client_secret: str
    youtube_token_uri: str
    upload_privacy_status: str
    retry_attempts: int
    retry_backoff_sec: int
    quota_total_per_day: int
    quota_cost_per_upload: int
    max_uploads_per_channel_per_day: int
    publish_base_time: str
    slot_interval_minutes: int
    channel_delay_minutes: int
    schedule_slots: list[str]
    tracker_path: Path
    quota_state_path: Path
    monitor_state_path: Path
    log_file_path: Path


def _parse_csv(value: str) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _parse_json_array(value: str) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _parse_int_env(name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    raw = os.getenv(name, "")
    try:
        value = int(str(raw).strip()) if str(raw).strip() else default
    except (TypeError, ValueError):
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _normalize_hhmm(value: str) -> str | None:
    raw = str(value or "").strip()
    parts = raw.split(":")
    if len(parts) != 2:
        return None
    try:
        hh = int(parts[0])
        mm = int(parts[1])
    except ValueError:
        return None
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        return None
    return f"{hh:02d}:{mm:02d}"


def _load_titles() -> list[str]:
    from_json = _parse_json_array(os.getenv("TITLES_JSON", ""))
    if from_json:
        return from_json
    return _parse_csv(os.getenv("TITLES", ""))


def _load_folder_ids() -> list[str]:
    from_json = _parse_json_array(os.getenv("DRIVE_FOLDER_IDS_JSON", ""))
    if from_json:
        return from_json
    from_csv = _parse_csv(os.getenv("DRIVE_FOLDER_IDS", ""))
    if from_csv:
        return from_csv
    single_id = os.getenv("DRIVE_FOLDER_ID", "").strip()
    return [single_id] if single_id else []


def _load_schedule_slots() -> list[str]:
    from_json = _parse_json_array(os.getenv("SCHEDULE_SLOTS_JSON", ""))
    slots: list[str] = []
    for item in from_json:
        normalized = _normalize_hhmm(item)
        if normalized:
            slots.append(normalized)

    if slots:
        # Keep unique order
        deduped = []
        seen = set()
        for slot in slots:
            if slot in seen:
                continue
            seen.add(slot)
            deduped.append(slot)
        return deduped

    return []


def load_config() -> AppConfig:
    root = Path(__file__).resolve().parents[1]
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    videos_per_day = _parse_int_env("VIDEOS_PER_DAY", default=5, minimum=1, maximum=5)

    cfg = AppConfig(
        videos_per_day=videos_per_day,
        titles=_load_titles(),
        description=os.getenv("DEFAULT_DESCRIPTION", "Uploaded via Ganga Digital Automation"),
        tags=_parse_csv(os.getenv("DEFAULT_TAGS", "")),
        drive_folder_ids=_load_folder_ids(),
        drive_api_key=(os.getenv("DRIVE_API_KEY", "").strip() or os.getenv("API_KEY", "").strip()),
        token_api_url=os.getenv("TOKEN_API_URL", "").strip(),
        tokens_json=os.getenv("TOKENS_JSON", "").strip(),
        token_api_timeout_sec=_parse_int_env("TOKEN_API_TIMEOUT_SEC", default=20, minimum=5),
        youtube_client_id=os.getenv("YOUTUBE_CLIENT_ID", "").strip(),
        youtube_client_secret=os.getenv("YOUTUBE_CLIENT_SECRET", "").strip(),
        youtube_token_uri=os.getenv("YOUTUBE_TOKEN_URI", "https://oauth2.googleapis.com/token").strip(),
        upload_privacy_status=os.getenv("YOUTUBE_PRIVACY_STATUS", "private").strip() or "private",
        retry_attempts=_parse_int_env("RETRY_ATTEMPTS", default=3, minimum=1, maximum=10),
        retry_backoff_sec=_parse_int_env("RETRY_BACKOFF_SEC", default=3, minimum=1, maximum=60),
        quota_total_per_day=_parse_int_env("QUOTA_TOTAL_PER_DAY", default=10000, minimum=1),
        quota_cost_per_upload=_parse_int_env("QUOTA_COST_PER_UPLOAD", default=1600, minimum=1),
        max_uploads_per_channel_per_day=_parse_int_env(
            "MAX_UPLOADS_PER_CHANNEL_PER_DAY",
            default=5,
            minimum=1,
            maximum=5,
        ),
        publish_base_time=_normalize_hhmm(os.getenv("PUBLISH_BASE_TIME", "16:00")) or "16:00",
        slot_interval_minutes=_parse_int_env("SLOT_INTERVAL_MINUTES", default=120, minimum=1, maximum=1440),
        channel_delay_minutes=_parse_int_env("CHANNEL_DELAY_MINUTES", default=2, minimum=1, maximum=60),
        schedule_slots=_load_schedule_slots(),
        tracker_path=data_dir / "uploads.json",
        quota_state_path=data_dir / "quota_state.json",
        monitor_state_path=data_dir / "monitor_status.json",
        log_file_path=data_dir / "automation.log",
    )
    return cfg


def build_slots_for_ui(config: AppConfig) -> list[dict[str, Any]]:
    slots: list[str] = config.schedule_slots[: config.videos_per_day]
    if not slots:
        hh, mm = map(int, config.publish_base_time.split(":"))
        total = hh * 60 + mm
        generated: list[str] = []
        for idx in range(config.videos_per_day):
            minutes = (total + idx * config.slot_interval_minutes) % (24 * 60)
            generated.append(f"{minutes // 60:02d}:{minutes % 60:02d}")
        slots = generated
    return [{"slot": idx + 1, "time": slot} for idx, slot in enumerate(slots)]
