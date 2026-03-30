# Ganga Digital Automation Backend

> WARNING: Do NOT modify backend files unless necessary.  
> This backend is integrated into the main app in isolated mode to avoid breaking frontend logic.

Production-ready backend automation for Google Drive -> YouTube multi-channel uploads with quota control, smart scheduling, and live monitoring state.

## Architecture

```text
/backend
  main.py
  scheduler.py
  quota_manager.py
  drive_service.py
  youtube_service.py
  downloader.py
  tracker.py
  token_service.py
  monitor.py
  logger.py
  config.py
  utils.py

/data
  uploads.json
  quota_state.json
  monitor_status.json
  automation.log

/.github/workflows
  run-backend.yml
  automation.yml
```

## What It Does

- Fetches videos in real-time from one or multiple Drive folders.
- Fetches channel tokens from `TOKEN_API_URL` **or** `TOKENS_JSON` fallback.
- Uploads up to 5 videos/channel/day with retry + resumable upload.
- Schedules uploads for **tomorrow (T+1)**.
- Staggers channels automatically (`CHANNEL_DELAY_MINUTES`, default 2 min).
- Tracks quota per channel (10,000/day default, 1,600 per upload default).
- Prevents duplicate uploads using `data/uploads.json`.
- Maintains live monitoring state in `data/monitor_status.json`.

## Key Environment Variables

Required:

- `DRIVE_API_KEY` (or `API_KEY`)
- `DRIVE_FOLDER_ID` or `DRIVE_FOLDER_IDS`
- `TOKEN_API_URL` **or** `TOKENS_JSON`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`

Optional controls:

- `VIDEOS_PER_DAY` (default `5`, max `5`)
- `DEFAULT_DESCRIPTION`
- `DEFAULT_TAGS`
- `TITLES_JSON` (array) or `TITLES` (CSV)
- `QUOTA_TOTAL_PER_DAY` (default `10000`)
- `QUOTA_COST_PER_UPLOAD` (default `1600`)
- `PUBLISH_BASE_TIME` (default `16:00`)
- `SLOT_INTERVAL_MINUTES` (default `120`)
- `CHANNEL_DELAY_MINUTES` (default `2`)
- `SCHEDULE_SLOTS_JSON` (example: `["16:00","18:00","20:00","22:00","23:30"]`)
- `RETRY_ATTEMPTS` (default `3`)
- `RETRY_BACKOFF_SEC` (default `3`)
- `YOUTUBE_TOKEN_URI` (default `https://oauth2.googleapis.com/token`)
- `YOUTUBE_PRIVACY_STATUS` (kept for compatibility)

## Token API Contract

`TOKEN_API_URL` should return:

```json
{
  "channels": [
    {
      "channel_id": "channel_1",
      "access_token": "ACCESS_TOKEN",
      "refresh_token": "REFRESH_TOKEN"
    }
  ]
}
```

## Monitoring Output

`data/monitor_status.json` contains:

- per-channel quota (`total`, `used`, `remaining`, `reset_at`)
- channel status (`Waiting`, `Uploading`, `Completed`, `Failed`)
- rolling log messages
- notification field (used for quota refresh message)

This file can be polled by frontend/backend API for near real-time updates.

## GitHub Actions

`run-backend.yml`
- daily schedule (`04:00 UTC`)
- manual trigger
- publishes summary:
  - Upload Success
  - Upload Failed
  - Skipped
  - Channels Processed
  - Channels Found
  - Videos Found
  - Exit Reason

`automation.yml`
- manual fallback runner

## Local Run

```bash
python -m pip install -r requirements.txt
python -m backend.main
```
