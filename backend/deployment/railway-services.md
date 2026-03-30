# Railway Service Layout

Create these 5 services inside one Railway project:

1. `gda-api`
- Root directory: `backend`
- Start command: `node dist/index.js`

2. `gda-worker`
- Root directory: `backend`
- Start command: `node dist/worker.js`

3. `gda-scheduler`
- Root directory: `backend`
- Start command: `node dist/scheduler.js`

4. `postgres`
- Add Railway Postgres plugin

5. `redis`
- Add Railway Redis plugin

## Shared env vars
Paste values from `deployment/railway.env.example` into API/Worker/Scheduler.
Use Railway Postgres/Redis generated URLs for `DATABASE_URL` and `REDIS_URL`.
