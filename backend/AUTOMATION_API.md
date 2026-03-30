# YouTube Automation API

Base routes are available both as plain paths and `/api` prefixed paths.

## 1) Connect Channel

### `POST /connect-channel`

Start OAuth:

```json
{
  "channel_name": "My Channel"
}
```

Response:

```json
{
  "success": true,
  "step": "authorize",
  "channel_id": "uuid",
  "state": "uuid",
  "auth_url": "https://accounts.google.com/..."
}
```

Complete OAuth:

```json
{
  "state": "uuid-from-start-step",
  "code": "oauth-code-from-google"
}
```

## 2) Upload Video

### `POST /upload-video`

- `multipart/form-data` with `file`, `title`, `description`, `tags`
- or JSON with `drive_link`, `title`, `description`, `tags`

If file is sent, backend uploads to Google Drive first and stores generated `drive_link`.
Queue records include extracted `drive_file_id`.

## 3) Videos List

### `GET /videos`

Returns queued videos with metadata and status.

## 4) Automation Toggle

### `POST /start-automation`
Enables queue automation.

### `POST /stop-automation`
Disables queue automation.

### `GET /automation-status`
Returns running state and queue summary.

## 5) OAuth callback helper

### `GET /oauth/callback?code=...&state=...`

Optional callback endpoint if your Google OAuth redirect URI points to backend.
