# Automation Runner

Hourly runner script:

```bash
node automation/upload.js
```

What it does:
- Reads queued videos from `database/automation-db.json`
- Checks automation on/off flag
- Enforces max `5` uploads/day
- Checks estimated YouTube quota usage
- Refreshes Google access token automatically
- Downloads pending videos from Google Drive
- Uploads to YouTube
- Marks video status as `uploaded`
