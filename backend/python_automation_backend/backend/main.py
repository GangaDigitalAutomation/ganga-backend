import os
import random
from pathlib import Path

from backend.config import AppConfig, build_slots_for_ui, load_config
from backend.downloader import DriveDownloader
from backend.drive_service import DriveService, DriveVideo
from backend.logger import AutomationLogger
from backend.monitor import Monitor
from backend.quota_manager import QuotaManager
from backend.scheduler import Scheduler
from backend.token_service import TokenService
from backend.tracker import UploadTracker
from backend.utils import pick_random_title, retry
from backend.youtube_service import YouTubeService


def _emit_diag(log: AutomationLogger, monitor: Monitor, reason: str) -> None:
    log.info(f"EXIT_REASON={reason}")
    monitor.add_log(f"EXIT_REASON={reason}")


def _safe_title(config: AppConfig, video: DriveVideo) -> str:
    fallback = f"GDA Upload {video.file_id[:8]}"
    return pick_random_title(config.titles, fallback=fallback)


def _prepare_ui_slots(log: AutomationLogger, config: AppConfig) -> None:
    slots = build_slots_for_ui(config)
    log.info("UI slot model ready", slots=slots)


def run() -> int:
    config = load_config()
    logger = AutomationLogger(config.log_file_path)
    monitor = Monitor(config.monitor_state_path)
    _prepare_ui_slots(logger, config)

    if not config.drive_folder_ids:
        logger.warning("No Drive folder id configured.")
        _emit_diag(logger, monitor, "NO_DRIVE_FOLDER")
        return 0
    if not config.token_api_url and not config.tokens_json:
        logger.warning("Missing TOKEN_API_URL and TOKENS_JSON.")
        _emit_diag(logger, monitor, "NO_TOKEN_SOURCE")
        return 0

    token_service = TokenService(config)
    drive_service = DriveService(config)
    downloader = DriveDownloader(config)
    youtube_service = YouTubeService(config)
    tracker = UploadTracker(config.tracker_path)
    quota = QuotaManager(
        config.quota_state_path,
        quota_total=config.quota_total_per_day,
        upload_cost=config.quota_cost_per_upload,
    )
    scheduler = Scheduler(config)

    logger.info("Fetching channel tokens")
    try:
        channels = token_service.fetch_channel_tokens()
    except Exception as error:  # noqa: BLE001
        logger.error("Failed to fetch channel tokens", error=str(error))
        _emit_diag(logger, monitor, "TOKEN_API_ERROR")
        return 0

    logger.info(f"CHANNELS_FOUND={len(channels)}")
    if not channels:
        _emit_diag(logger, monitor, "NO_CHANNELS")
        return 0

    prime_channel = channels[0]
    prime_access_token = prime_channel.access_token
    if not prime_access_token:
        try:
            prime_access_token = token_service.refresh_access_token(prime_channel.refresh_token)
        except Exception as error:  # noqa: BLE001
            logger.error("Failed to get OAuth token for Drive listing", error=str(error))
            _emit_diag(logger, monitor, "DRIVE_TOKEN_ERROR")
            return 0

    logger.info("Fetching Drive videos", folders=len(config.drive_folder_ids))
    try:
        videos = drive_service.fetch_all_videos(config.drive_folder_ids, prime_access_token)
    except Exception as error:  # noqa: BLE001
        logger.error("Drive fetch failed", error=str(error))
        _emit_diag(logger, monitor, "DRIVE_FETCH_ERROR")
        return 0

    logger.info(f"VIDEOS_FOUND={len(videos)}")
    if not videos:
        _emit_diag(logger, monitor, "NO_VIDEOS")
        return 0

    # Randomization requirement: avoid same order uploads.
    random.shuffle(videos)

    total_uploaded = 0
    for channel_index, channel in enumerate(channels):
        monitor.set_channel_status(channel.channel_id, status="Waiting")
        channel_quota, refreshed = quota.get_channel_quota(channel.channel_id)
        if refreshed:
            notice = f"Quota refreshed - uploading started ({channel.channel_id})"
            monitor.set_notification(notice)
            monitor.add_log(notice)
            logger.info("Quota refreshed", channel_id=channel.channel_id)

        max_by_quota = channel_quota.remaining // channel_quota.upload_cost
        max_by_policy = min(config.videos_per_day, config.max_uploads_per_channel_per_day)
        upload_budget = max(0, min(max_by_policy, max_by_quota))

        monitor.set_quota(
            channel.channel_id,
            total=channel_quota.total,
            used=channel_quota.used,
            remaining=channel_quota.remaining,
            reset_at=channel_quota.resets_at,
        )

        if upload_budget <= 0:
            monitor.set_channel_status(channel.channel_id, status="Waiting", error="No quota remaining")
            logger.warning("Quota exhausted for channel", channel_id=channel.channel_id)
            continue

        access_token = channel.access_token
        if not access_token:
            try:
                access_token = token_service.refresh_access_token(channel.refresh_token)
            except Exception as error:  # noqa: BLE001
                msg = f"Token refresh failed: {error}"
                logger.error(msg, channel_id=channel.channel_id)
                monitor.set_channel_status(channel.channel_id, status="Failed", error=msg)
                continue

        # Per-channel candidate set (skip duplicates strictly).
        candidates = [video for video in videos if not tracker.is_uploaded(channel.channel_id, video.file_id)]
        skipped_duplicates = len(videos) - len(candidates)
        if skipped_duplicates > 0:
            logger.info("[SKIP]", channel_id=channel.channel_id, duplicates=skipped_duplicates)
        random.shuffle(candidates)
        if not candidates:
            logger.info("No new videos for channel", channel_id=channel.channel_id)
            monitor.set_channel_status(channel.channel_id, status="Waiting", error="No new videos")
            continue

        uploads_for_channel = 0
        for slot_index in range(upload_budget):
            if not candidates:
                break
            video = candidates.pop()

            schedule_slot = scheduler.compute_slot(channel_index=channel_index, slot_index=slot_index)
            title = _safe_title(config, video)
            temp_path: Path | None = None

            monitor.set_channel_status(channel.channel_id, status="Uploading", video_name=video.name)
            monitor.add_log(
                f"Uploading video '{video.name}' for channel '{channel.channel_id}' "
                f"publish_at={schedule_slot.publish_at_utc}"
            )

            try:
                temp_path = retry(
                    lambda: downloader.download_video(video.file_id, video.name, access_token),
                    attempts=config.retry_attempts,
                    backoff_sec=config.retry_backoff_sec,
                    on_retry=lambda attempt, err: logger.warning(
                        "Download retry",
                        attempt=attempt,
                        channel_id=channel.channel_id,
                        file_id=video.file_id,
                        error=str(err),
                    ),
                )

                youtube_video_id = retry(
                    lambda: youtube_service.upload_video(
                        access_token=access_token,
                        refresh_token=channel.refresh_token,
                        file_path=temp_path,
                        title=title,
                        description=config.description,
                        tags=config.tags,
                        publish_at=schedule_slot.publish_at_utc,
                    ),
                    attempts=config.retry_attempts,
                    backoff_sec=config.retry_backoff_sec,
                    on_retry=lambda attempt, err: logger.warning(
                        "Upload retry",
                        attempt=attempt,
                        channel_id=channel.channel_id,
                        file_id=video.file_id,
                        error=str(err),
                    ),
                )

                tracker.mark_uploaded(
                    channel_id=channel.channel_id,
                    drive_file_id=video.file_id,
                    youtube_video_id=youtube_video_id,
                    publish_at=schedule_slot.publish_at_utc,
                    title=title,
                )

                updated_quota = quota.consume_upload(channel.channel_id, uploads_count=1)
                monitor.set_quota(
                    channel.channel_id,
                    total=updated_quota.total,
                    used=updated_quota.used,
                    remaining=updated_quota.remaining,
                    reset_at=updated_quota.resets_at,
                )
                monitor.set_channel_status(
                    channel.channel_id,
                    status="Completed",
                    video_name=video.name,
                    youtube_video_id=youtube_video_id,
                )
                monitor.add_log(
                    f"Upload complete channel={channel.channel_id} drive={video.file_id} "
                    f"youtube={youtube_video_id} quota_used={updated_quota.used}"
                )
                logger.info(
                    "[UPLOAD_SUCCESS]",
                    channel_id=channel.channel_id,
                    drive_file_id=video.file_id,
                    youtube_video_id=youtube_video_id,
                    publish_at=schedule_slot.publish_at_utc,
                    slot=schedule_slot.slot_index,
                )
                uploads_for_channel += 1
                total_uploaded += 1
            except Exception as error:  # noqa: BLE001
                monitor.set_channel_status(channel.channel_id, status="Failed", video_name=video.name, error=str(error))
                monitor.add_log(f"Upload failed channel={channel.channel_id} drive={video.file_id} error={error}")
                logger.error(
                    "Upload failed",
                    channel_id=channel.channel_id,
                    drive_file_id=video.file_id,
                    error=str(error),
                )
            finally:
                if temp_path and temp_path.exists():
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass

        logger.info(
            "[CHANNEL_DONE]",
            channel_id=channel.channel_id,
            uploaded=uploads_for_channel,
            budget=upload_budget,
        )

    logger.info("Automation run complete", uploaded_total=total_uploaded)
    _emit_diag(logger, monitor, "COMPLETED")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
