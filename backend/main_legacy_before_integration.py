from __future__ import annotations

import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from downloader import detect_mime_type
from drive_service import download_from_drive, parse_drive_file_id
from logger import configure_logger
from monitor import MonitorState
from quota_manager import DAILY_QUOTA_LIMIT, MAX_DAILY_UPLOADS, UPLOAD_UNITS, QuotaManager
from scheduler import build_automation_slots_payload, build_smart_schedule, next_run_after_tomorrow
from token_service import from_channel_record
from tracker import UploadTracker
from youtube_service import upload_video_resumable


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "uploads.json"
MONITOR_PATH = ROOT / "data" / "monitor_state.json"
LOG_PATH = ROOT / "data" / "automation.log"
CHANNEL_GAP_SECONDS = int(os.getenv("CHANNEL_GAP_SECONDS", "120"))
VIDEOS_PER_DAY = max(1, min(5, int(os.getenv("VIDEOS_PER_DAY", "5"))))


def _group_pending_by_channel(records: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for video in records:
        if str(video.get("status") or "pending") != "pending":
            continue
        channel_id = str(video.get("channel_id") or "").strip()
        if not channel_id:
            continue
        grouped.setdefault(channel_id, []).append(video)
    return grouped


def _update_channel_tokens(tracker: UploadTracker, channel_id: str, access_token: str) -> None:
    def _mutate(data: dict[str, Any]) -> None:
        for channel in data.get("channels", []):
            if str(channel.get("id")) == channel_id:
                channel["access_token"] = access_token
                channel["updated_at"] = datetime.now(timezone.utc).isoformat()

    tracker.mutate(_mutate)


def run_once() -> dict[str, Any]:
    logger = configure_logger("gda.automation", LOG_PATH)
    tracker = UploadTracker(DATA_PATH)
    quota = QuotaManager(tracker)
    monitor = MonitorState(MONITOR_PATH)

    snapshot = tracker.read()
    channels = [c for c in snapshot.get("channels", []) if c.get("id")]
    queue = snapshot.get("video_queue", [])

    monitor.set_automation_panel(
        build_automation_slots_payload(
            channels=channels,
            videos=queue,
            videos_per_day=VIDEOS_PER_DAY,
        )
    )

    if not channels:
        message = "No channels configured. Add channel credentials to data/uploads.json"
        logger.warning(message)
        monitor.log(message, level="warning")
        return {"ok": False, "reason": message}

    refreshed = quota.check_and_mark_resets()
    if refreshed:
        monitor.notify("Quota refreshed - uploading started")

    grouped = _group_pending_by_channel(queue)
    scheduled = build_smart_schedule(
        channels=channels,
        videos_by_channel=grouped,
        videos_per_day=VIDEOS_PER_DAY,
        base_hour=16,
        base_minute=0,
        channel_gap_minutes=2,
    )

    scheduled_by_channel: dict[str, list[dict[str, Any]]] = {}
    for item in scheduled:
        scheduled_by_channel.setdefault(item.channel_id, []).append(
            {
                "video_id": item.video_id,
                "publish_at": item.publish_at_iso,
                "slot_time": item.slot_time,
                "slot_date": item.slot_date,
            }
        )

    uploaded_count = 0
    failed_count = 0

    for channel_index, channel in enumerate(channels):
        channel_id = str(channel.get("id"))
        channel_name = str(channel.get("channel_name") or channel.get("name") or channel_id)
        monitor.set_channel_status(channel_id, "waiting", "Preparing channel run")

        try:
            channel_creds = from_channel_record(channel)
        except Exception as exc:
            failed_count += 1
            message = f"[{channel_name}] invalid OAuth credentials: {exc}"
            logger.error(message)
            monitor.set_channel_status(channel_id, "failed", message)
            monitor.log(message, level="error")
            continue

        allowed, status = quota.can_upload(channel_id, UPLOAD_UNITS)
        monitor.set_quota(channel_id, DAILY_QUOTA_LIMIT, status.used_units, status.remaining_units)
        if not allowed:
            message = f"[{channel_name}] quota exhausted or daily upload limit reached"
            logger.info(message)
            monitor.log(message)
            monitor.set_channel_status(channel_id, "waiting", "Quota limit reached")
            continue

        channel_items = scheduled_by_channel.get(channel_id, [])
        if not channel_items:
            monitor.set_channel_status(channel_id, "waiting", "No pending videos")
            continue

        for planned in channel_items[:MAX_DAILY_UPLOADS]:
            video_id = str(planned["video_id"])
            publish_at = str(planned["publish_at"])
            publish_date = publish_at.split("T", 1)[0]

            queue_item = next(
                (v for v in queue if str(v.get("video_id") or v.get("id")) == video_id and str(v.get("channel_id") or "") == channel_id),
                None,
            )
            if not queue_item:
                continue

            if tracker.has_duplicate_upload(channel_id, video_id, publish_date):
                message = f"[{channel_name}] duplicate prevented for video {video_id} on {publish_date}"
                logger.info(message)
                monitor.log(message)
                tracker.mark_video_status(video_id, channel_id, "uploaded")
                continue

            allowed, status = quota.can_upload(channel_id, UPLOAD_UNITS)
            monitor.set_quota(channel_id, DAILY_QUOTA_LIMIT, status.used_units, status.remaining_units)
            if not allowed:
                break

            title = str(queue_item.get("title") or "Untitled Video")
            description = str(queue_item.get("description") or "Uploaded via Ganga Digital Automation")
            tags = [str(t).strip() for t in queue_item.get("tags", []) if str(t).strip()]
            drive_id = str(queue_item.get("drive_file_id") or queue_item.get("drive_link") or "").strip()
            parsed_drive_id = parse_drive_file_id(drive_id)
            if not parsed_drive_id:
                failed_count += 1
                message = f"[{channel_name}] invalid drive file id for video {video_id}"
                logger.error(message)
                monitor.set_channel_status(channel_id, "failed", message)
                monitor.log(message, level="error")
                tracker.mark_video_status(video_id, channel_id, "failed", error=message)
                continue

            monitor.set_channel_status(channel_id, "uploading", f"Uploading {title}")
            monitor.log(f"Uploading video {title} for {channel_name}")

            with tempfile.TemporaryDirectory(prefix="gda-") as tmp_dir:
                tmp_file = Path(tmp_dir) / f"{video_id}.mp4"
                try:
                    download_from_drive(channel_creds, parsed_drive_id, tmp_file)
                    mime_type = str(queue_item.get("mime_type") or "").strip() or detect_mime_type(tmp_file)

                    result = upload_video_resumable(
                        channel_creds,
                        tmp_file,
                        title=title,
                        description=description,
                        tags=tags,
                        publish_at_iso=publish_at,
                        mime_type=mime_type,
                        max_retries=3,
                    )

                    # Persist latest access token after refresh.
                    if hasattr(channel_creds, "access_token") and channel_creds.access_token:
                        _update_channel_tokens(tracker, channel_id, channel_creds.access_token)

                    tracker.add_upload_record(
                        channel_id=channel_id,
                        video_id=video_id,
                        publish_at=publish_at,
                        youtube_video_id=result.youtube_video_id,
                        quota_units=UPLOAD_UNITS,
                    )
                    tracker.mark_video_status(
                        video_id,
                        channel_id,
                        "uploaded",
                        youtube_video_id=result.youtube_video_id,
                    )
                    quota_state = quota.consume(channel_id, UPLOAD_UNITS)
                    monitor.set_quota(channel_id, DAILY_QUOTA_LIMIT, quota_state.used_units, quota_state.remaining_units)

                    uploaded_count += 1
                    success_message = (
                        f"[{channel_name}] upload complete: {title} -> {result.youtube_video_id} "
                        f"(quota used {quota_state.used_units}/{DAILY_QUOTA_LIMIT})"
                    )
                    logger.info(success_message)
                    monitor.log(success_message)
                    monitor.set_channel_status(channel_id, "completed", success_message)
                except Exception as exc:
                    failed_count += 1
                    error_message = f"[{channel_name}] upload failed for {title}: {exc}"
                    logger.error(error_message)
                    monitor.log(error_message, level="error")
                    monitor.set_channel_status(channel_id, "failed", error_message)
                    tracker.mark_video_status(video_id, channel_id, "failed", error=str(exc))

        if channel_index < len(channels) - 1:
            wait_text = f"Waiting {CHANNEL_GAP_SECONDS}s before next channel"
            monitor.log(wait_text)
            time.sleep(CHANNEL_GAP_SECONDS)

    now_iso = datetime.now(timezone.utc).isoformat()
    next_run = next_run_after_tomorrow().isoformat()
    tracker.set_runtime(last_run_at=now_iso, next_run_at=next_run)

    summary = {
        "ok": True,
        "uploaded": uploaded_count,
        "failed": failed_count,
        "processed_channels": len(channels),
        "next_run_at": next_run,
    }
    monitor.log(f"Run complete. Uploaded={uploaded_count}, Failed={failed_count}")
    return summary


if __name__ == "__main__":
    result = run_once()
    print(result)
