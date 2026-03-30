# Ganga Digital Automation: One-Click Deploy

Production-ready YouTube automation platform with:

- API + Worker + Scheduler backend
- Queue processing (BullMQ + Redis fallback)
- Postgres + fallback local DB mode
- Real-time SSE events
- Fixed daily slot scheduling + humanized upload timing

## One-Click Buttons

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

## Beginner Setup (Only 3 Inputs)

Use the setup assistant:

- [Open Setup Assistant](./deployment/setup-assistant.html)

You only fill:

1. `GOOGLE_CLIENT_ID`
2. `GOOGLE_CLIENT_SECRET`
3. `ALLOWED_EMAILS`

Everything else has safe defaults.

## 5-Step Deploy

1. Push this folder to your GitHub repository.
2. Click **Deploy on Railway** and connect the repo (`backend/` service root).
3. Add Postgres + Redis in Railway, then paste env from `backend/deployment/railway.env.example`.
4. Click **Deploy with Vercel** and connect the same repo (static frontend from `renderer/`).
5. Open app, login, and click **START AUTOMATION**.

## Defaults (Safe by Default)

- `SIMULATION_MODE=true` by default
- If `DATABASE_URL` is missing: fallback DB mode
- If `REDIS_URL` is missing: fallback file queue mode

## Deployment Files

- Backend runtime config: [backend/railway.json](./backend/railway.json)
- Railway env template: [backend/deployment/railway.env.example](./backend/deployment/railway.env.example)
- Vercel frontend config: [vercel.json](./vercel.json)
- Docker image: [backend/Dockerfile](./backend/Dockerfile)
- Multi-service local stack: [backend/docker-compose.yml](./backend/docker-compose.yml)
- Process mode: [backend/Procfile](./backend/Procfile)
