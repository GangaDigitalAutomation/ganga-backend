# Product Requirements Document (PRD)

## 1. Product Name
Ganga Digital Automation (Desktop App)  
Version: 2.0.1

## 2. Purpose
Ganga Digital Automation helps creators and teams upload and schedule many YouTube videos across multiple channels from one desktop app.

The app reduces manual work by:
- importing a video folder once
- connecting multiple YouTube channels
- auto-generating a publishing schedule
- auto-assigning videos, titles, tags, and description
- uploading in background with progress tracking

## 3. Target Users
- YouTube channel managers
- Agencies managing multiple client channels
- Solo creators with many videos to schedule
- Operations teams doing bulk uploads

## 4. Problem Statement
Manual YouTube scheduling is slow and repetitive when users handle:
- many channels
- many videos
- day-by-day planning
- repeated metadata (tags/description)

Users need one place to plan and execute uploads quickly with fewer mistakes.

## 5. Goals
- Enable users to connect YouTube channels safely using OAuth.
- Let users load video libraries from local folders.
- Generate practical schedules in a few clicks.
- Assign videos and metadata automatically.
- Run uploads reliably with visible progress and logs.
- Keep schedule dates always forward-looking (starting from tomorrow by default).

## 6. Non-Goals
- Editing video files
- Advanced analytics/reporting dashboards
- Cross-platform mobile app behavior (this PRD is for desktop flow)
- Team collaboration/permissions
- Support for platforms other than YouTube

## 7. Core User Flows

### Flow A: Load Videos
1. User opens Video Library.
2. User drags a folder or clicks "Select Folder".
3. App scans subfolders for supported files (`.mp4`, `.mkv`, `.mov`, `.avi`).
4. App saves video list with size, path, and auto-generated title.

### Flow B: Connect Channel
1. User opens Channels and clicks "Add Channel".
2. User enters Client ID + Client Secret and provides OAuth JSON (file or pasted text).
3. App opens Google sign-in popup.
4. On success, app stores encrypted credentials/tokens and fetches channel details.
5. Connected channel appears in channel list and is selected by default.

### Flow C: Build Schedule
1. User chooses days (1-10) and videos per day (1-8).
2. User clicks "AUTO SCHEDULE".
3. App creates slots per selected channel, starting from tomorrow.
4. App auto-assigns videos into schedule items.
5. User can edit date, time, and video per slot manually.

### Flow D: Apply Metadata
1. User sets Global Tags (chip-based input).
2. User sets Global Description.
3. User optionally pastes multiple titles and runs auto-title assignment.
4. App applies metadata across videos and mapped schedule slots.

### Flow E: Upload
1. User clicks "Start Upload & Schedule".
2. App checks internet connection and selected channels.
3. App uploads scheduled videos (concurrency: 2).
4. Progress bar updates for bytes and video count.
5. Logs show day/slot status (`UPLOADING`, `SUCCESS`, `FAILED`).
6. Completed uploads are marked in state to prevent duplicate uploads for same file + publish time.

## 8. Functional Requirements

### FR-1 Navigation
- App must provide pages: Dashboard, Video Library, Channels, Smart Scheduling.

### FR-2 Video Import
- App must accept folder selection and drag-drop.
- App must recursively scan folders.
- App must reject invalid path or no-video folder with clear error.

### FR-3 Channel Management
- App must allow add, remove, open channel, and select/unselect channel for operations.
- App must show readable errors for OAuth issues (invalid client, redirect mismatch, timeout, network).

### FR-4 Credentials Security
- Sensitive channel credentials/tokens must be encrypted locally before storage.
- Sanitized app state sent to UI must not expose sensitive fields.

### FR-5 Schedule Generation
- App must generate schedule by day and slot.
- Schedule defaults start from tomorrow.
- Slot times:
  - preset for 1-4 videos/day
  - evenly distributed 04:00-22:00 for 5-8 videos/day
- Multi-channel slots should avoid exact timestamp collisions.

### FR-6 Schedule Editing
- User must be able to:
  - change slot video assignment
  - change slot time
  - change day date (cascade from selected day forward)
- App must validate date input before applying.

### FR-7 Metadata
- App must support global tags and global description.
- App must support bulk auto-title assignment from multi-line input.

### FR-8 Upload Engine
- App must check internet before upload.
- App must skip invalid tasks (missing file, missing assignment, past publish date).
- App must retry failed uploads up to 3 attempts per item.
- App must mark schedule item status (`pending`, `uploaded`, `failed`).
- App must persist uploaded history by channel.

### FR-9 Progress & Logs
- App must show:
  - percent uploaded
  - bytes uploaded / total bytes
  - completed videos / total videos
- App must provide timestamped system logs.
- If window is minimized during upload, app should notify background upload.

### FR-10 Connectivity Indicator
- App must refresh internet status periodically (every 15 seconds).

## 9. Non-Functional Requirements
- Desktop performance should remain responsive during library rendering and upload progress updates.
- State must persist locally in user app data (`store.json`).
- App should handle restart without losing saved channels/videos/schedules/settings.
- Localized time offsets must be preserved in scheduled publish timestamps.

## 10. Data Model (High Level)

### Channel
- `id`
- `title/label`
- `thumbnail`
- `channelUrl`
- encrypted: `clientId`, `clientSecret`, `tokensEncrypted`, optional `apiKey`
- `selected`, `starred`
- `uploaded[]` history (videoId, videoPath, publishAt)

### Video
- `name`
- `path`
- `size`
- `title`

### Schedule Item
- `id`
- `channelId` (via schedule map key)
- `dayIndex`
- `slotIndex`
- `date`
- `time`
- `publishAt` (ISO with local offset)
- `videoPath`
- `title`
- `description`
- `tags[]`
- `status`

### Settings
- `days`
- `videosPerDay`
- `globalTags`
- `defaultDescription`

## 11. UX Requirements
- Clear empty states for no videos/channels/schedule.
- Fast one-click actions for common tasks (auto schedule, start upload, select folder).
- Inline validation for bad date input and missing required OAuth fields.
- Success/error toast for channel connect.

## 12. Success Metrics
- Time to first complete schedule (target: under 5 minutes for first-time user).
- Upload success rate per run.
- Reduction in manual edits after auto-schedule and auto-assign.
- Number of channels and videos handled per session.

## 13. Risks and Mitigations
- OAuth setup errors (high): provide clear error mapping and JSON import support.
- Invalid publish times (medium): skip invalid entries and log reason.
- Duplicate uploads (medium): store uploaded history and skip repeated file+time pairs.
- Network instability (medium): retry upload tasks up to 3 attempts.

## 14. Release Scope (Current)
Included:
- Local desktop app (Electron)
- Multi-channel OAuth connection
- Library import
- Auto scheduling + auto assignment
- Upload execution with progress/logs

Not included:
- Cloud sync
- User accounts
- Team roles
- YouTube analytics ingestion

## 15. Acceptance Criteria
- User can connect at least one YouTube channel successfully.
- User can load a video folder and view imported videos.
- User can auto-generate schedule for selected channels.
- User can edit slot date/time/video and changes persist.
- User can run upload and see progress and logs update live.
- Successful uploads are marked and not re-uploaded on next run for same file+publishAt.

