# Environment Setup

Copy `config/.env.example` values into your runtime environment:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `TOKEN_ENCRYPTION_KEY`
- `AUTOMATION_DB_PATH`

For GitHub Actions, store these as repository secrets.

## Desktop Auto-Update

Desktop app reads update server URL from either:

- `GDA_UPDATE_BASE_URL` environment variable, or
- `config/update.json` -> `baseUrl`

Example:

```json
{
  "baseUrl": "https://your-domain.com/gda-updates"
}
```

This URL must host electron-builder update artifacts (`latest.yml` and installer files for each release version).
