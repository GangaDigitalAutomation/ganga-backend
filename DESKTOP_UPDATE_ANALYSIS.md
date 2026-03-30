# Desktop Update Analysis (March 27, 2026)

## Problem Summary

App was opening old build behavior and not updating to latest version automatically.

## Root Causes Found

1. No real auto-update engine was wired in `electron/main.js`.
2. No renderer UI existed to check/download/install updates.
3. Build was using old `squirrel` target and had mixed old/new installer traces.
4. Installer naming in `scripts/build-installer.js` was hardcoded to `1.0.0`.
5. Packaging previously failed due missing runtime dependency `@babel/plugin-proposal-export-namespace-from`.

## What Has Been Implemented

1. Added updater integration using `electron-updater` in main process.
2. Added IPC update endpoints:
   - `get-app-meta`
   - `get-update-status`
   - `check-for-updates`
   - `install-downloaded-update`
3. Added preload bridge APIs and renderer event listener for live update status.
4. Added dashboard card "App Updates" with:
   - current version
   - available version
   - check updates button
   - install & restart button
5. Switched Windows target to `nsis` for stable modern update flow.
6. Fixed installer naming to use dynamic package version.
7. Added `config/update.json` to configure update server URL.
8. Added cleanup script to remove old installs and launch new installer.

## Files Changed

- `electron/main.js`
- `electron/preload.js`
- `renderer/index.html`
- `renderer/app.js`
- `renderer/styles.css`
- `package.json`
- `config/README.md`
- `config/update.json`
- `scripts/build-installer.js`
- `scripts/clean-old-install.ps1`

## Build/Test Status

1. JS syntax checks passed:
   - `node --check electron/main.js`
   - `node --check electron/preload.js`
   - `node --check renderer/app.js`
2. `npm install` completed and dependencies were updated.
3. `npm run dist` reached artifact generation (`dist/ganga-digital-automation-2.0.2-x64.nsis.7z`) but command was long-running in this environment and was manually stopped after timeout.

## How To Use New Update System

1. Set update server URL in `config/update.json`:
   - `{ "baseUrl": "https://your-server/path" }`
2. Build/install latest app (NSIS).
3. Open app -> Dashboard -> `App Updates` card.
4. Click `Check for Updates`.
5. When status shows downloaded, click `Install Update & Restart`.

## Old Version Cleanup + Fresh Install

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\clean-old-install.ps1 -InstallerPath "C:\path\to\Ganga Digital Automation Setup 2.0.2.exe"
```

If installer path is skipped, script only removes old installed copies.
