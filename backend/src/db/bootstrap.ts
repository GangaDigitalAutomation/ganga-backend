import type { App } from "../core/createApp.js";

const bootstrapSql = [
  `create table if not exists users (
    id uuid primary key,
    email text not null,
    name text,
    is_allowed boolean not null default false,
    created_at text not null default '',
    updated_at text not null default ''
  );`,
  `create unique index if not exists users_email_unique_idx on users(lower(email));`,
  `create table if not exists channels (
    id uuid primary key,
    name text not null,
    channel_name text,
    youtube_url text,
    client_id text not null,
    client_secret text not null,
    access_token text,
    refresh_token text,
    token_status text not null default 'not_connected',
    is_selected boolean not null default true,
    token_expiry text,
    youtube_channel_id text,
    youtube_channel_url text,
    is_starred boolean not null default false,
    status text not null default 'disconnected',
    created_at text not null default ''
  );`,
  `create table if not exists videos (
    id uuid primary key,
    name text not null,
    file_path text not null,
    size_bytes bigint not null,
    extension text not null,
    created_at text not null default ''
  );`,
  `create table if not exists schedules (
    id uuid primary key,
    channel_id uuid not null references channels(id) on delete cascade,
    video_id uuid not null references videos(id) on delete cascade,
    scheduled_at text not null,
    publish_at text,
    slot_no integer,
    upload_at text,
    status text not null default 'pending',
    youtube_video_id text,
    error_message text,
    retry_count integer not null default 0,
    created_at text not null default ''
  );`,
  `create index if not exists schedules_status_idx on schedules(status);`,
  `create index if not exists schedules_upload_at_idx on schedules(upload_at);`,
  `create table if not exists upload_jobs (
    id uuid primary key,
    schedule_id uuid not null references schedules(id) on delete cascade,
    status text not null default 'queued',
    attempts integer not null default 0,
    max_attempts integer not null default 3,
    queue_mode text not null default 'file',
    last_error text,
    queued_at text not null default '',
    started_at text,
    completed_at text,
    updated_at text not null default ''
  );`,
  `create unique index if not exists upload_jobs_schedule_unique_idx on upload_jobs(schedule_id);`,
  `create table if not exists upload_events (
    id uuid primary key,
    schedule_id uuid references schedules(id) on delete set null,
    upload_job_id uuid references upload_jobs(id) on delete set null,
    event_type text not null,
    payload text not null default '{}',
    created_at text not null default ''
  );`,
  `create index if not exists upload_events_type_idx on upload_events(event_type);`,
  `create table if not exists channel_quota_usage (
    id uuid primary key,
    channel_id uuid not null references channels(id) on delete cascade,
    usage_date text not null,
    units_used integer not null default 0,
    updated_at text not null default ''
  );`,
  `create unique index if not exists channel_quota_unique_idx on channel_quota_usage(channel_id, usage_date);`,
  `create table if not exists automation_runtime (
    id uuid primary key,
    is_running boolean not null default false,
    started_at text,
    stopped_at text,
    updated_at text not null default ''
  );`,
  `create table if not exists upload_logs (
    id uuid primary key,
    schedule_id uuid references schedules(id) on delete set null,
    channel_id uuid references channels(id) on delete set null,
    level text not null,
    message text not null,
    created_at text not null default ''
  );`,
];

const alterStatements = [
  `alter table schedules add column if not exists upload_at text;`,
  `alter table schedules add column if not exists publish_at text;`,
  `alter table schedules add column if not exists slot_no integer;`,
  `alter table upload_jobs add column if not exists queue_mode text not null default 'file';`,
  `alter table users add column if not exists is_allowed boolean not null default false;`,
  `alter table automation_runtime add column if not exists is_running boolean not null default false;`,
  `alter table automation_runtime add column if not exists started_at text;`,
  `alter table automation_runtime add column if not exists stopped_at text;`,
  `alter table automation_runtime add column if not exists updated_at text not null default '';`,
];

export async function ensureSchema(app: App) {
  for (const statement of bootstrapSql) {
    await app.db.execute(statement);
  }
  for (const alter of alterStatements) {
    await app.db.execute(alter);
  }
}
