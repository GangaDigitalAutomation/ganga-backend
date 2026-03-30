# Automation Database Schema

`database/automation-db.json` contains:

## channels
- `id`
- `channel_name`
- `access_token` (encrypted)
- `refresh_token` (encrypted)
- `expiry_date`

## videos
- `id`
- `drive_file_id`
- `drive_link`
- `assigned_title`
- `title`
- `size`
- `description`
- `tags`
- `status` (`pending` or `uploaded`)
- `upload_count`

## automation
- `is_running`
- `updated_at`

## settings (store.json)
- `globalTags`
- `globalDescription`
- `titlePool` (array of reusable upload titles)
