# Ganga YouTube Automation Backend

Production-ready Node.js backend for automated YouTube publishing with:

- Fastify API
- Scheduler + Worker services
- BullMQ + Redis queue (`upload_execute`) with deadletter (`upload_deadletter`)
- File queue fallback when Redis is unavailable
- Postgres (preferred) with PGlite fallback
- Google Drive -> YouTube upload pipeline (real mode) + simulation fallback
- SSE real-time events with replay (`Last-Event-ID`, last 500 events)
- Allowlist-based auth with JWT sessions
- Human-like schedule timing windows for 5 daily publish slots

## Quick Start (Local)

```bash
npm install
cp .env.example .env
npm run build
npm run dev
```

Run separated services (production-like):

```bash
npm run build
npm run start
npm run start:worker
npm run start:scheduler
```

## Infra Modes

- `DATABASE_URL` unset -> PGlite fallback
- `REDIS_URL` unset -> file queue fallback
- Both set -> Postgres + BullMQ/Redis

## Required Environment Variables

- `JWT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `TOKEN_ENCRYPTION_KEY` (32+ chars)
- `ALLOWED_EMAILS` (comma-separated) for allowlist auth

See `.env.production.example` for a complete production template.

## Validation

```bash
npm run typecheck
npm run build
npm run validate:timing
npm run test:e2e:automation
```

## Deploy (Railway/Render)

1. Set service to Node 20.
2. Build command: `npm install && npm run build`
3. Start commands:
   - API: `node dist/index.js`
   - Worker: `node dist/worker.js`
   - Scheduler: `node dist/scheduler.js`
4. Add `DATABASE_URL`, `REDIS_URL`, Google OAuth vars, and auth secrets.
5. Optionally deploy via Docker using `Dockerfile`.

`Procfile` is provided for process-based platforms.
