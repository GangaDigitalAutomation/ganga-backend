import { randomUUID } from "node:crypto";
import { pgTable, uuid, text, bigint, boolean, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  email: text("email").notNull(),
  name: text("name"),
  is_allowed: boolean("is_allowed").notNull().default(false),
  created_at: text("created_at").notNull().default(sql`now()::text`),
  updated_at: text("updated_at").notNull().default(sql`now()::text`),
});

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  channel_name: text("channel_name"),
  youtube_url: text("youtube_url"),
  client_id: text("client_id").notNull(),
  client_secret: text("client_secret").notNull(),
  access_token: text("access_token"),
  refresh_token: text("refresh_token"),
  token_status: text("token_status").notNull().default("not_connected"),
  is_selected: boolean("is_selected").notNull().default(true),
  token_expiry: text("token_expiry"),
  youtube_channel_id: text("youtube_channel_id"),
  youtube_channel_url: text("youtube_channel_url"),
  is_starred: boolean("is_starred").notNull().default(false),
  status: text("status").notNull().default("disconnected"),
  created_at: text("created_at").notNull().default(sql`now()::text`),
});

export const videos = pgTable("videos", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  file_path: text("file_path").notNull(),
  size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
  extension: text("extension").notNull(),
  created_at: text("created_at").notNull().default(sql`now()::text`),
});

export const schedules = pgTable("schedules", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  channel_id: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  video_id: uuid("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  scheduled_at: text("scheduled_at").notNull(),
  publish_at: text("publish_at"),
  slot_no: integer("slot_no"),
  upload_at: text("upload_at"),
  status: text("status").notNull().default("pending"),
  youtube_video_id: text("youtube_video_id"),
  error_message: text("error_message"),
  retry_count: integer("retry_count").notNull().default(0),
  created_at: text("created_at").notNull().default(sql`now()::text`),
});

export const channel_quota_usage = pgTable("channel_quota_usage", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  channel_id: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  usage_date: text("usage_date").notNull(),
  units_used: integer("units_used").notNull().default(0),
  updated_at: text("updated_at").notNull().default(sql`now()::text`),
});

export const automation_runtime = pgTable("automation_runtime", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  is_running: boolean("is_running").notNull().default(false),
  started_at: text("started_at"),
  stopped_at: text("stopped_at"),
  updated_at: text("updated_at").notNull().default(sql`now()::text`),
});

export const upload_jobs = pgTable("upload_jobs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  schedule_id: uuid("schedule_id").notNull().references(() => schedules.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  max_attempts: integer("max_attempts").notNull().default(3),
  queue_mode: text("queue_mode").notNull().default("file"),
  last_error: text("last_error"),
  queued_at: text("queued_at").notNull().default(sql`now()::text`),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  updated_at: text("updated_at").notNull().default(sql`now()::text`),
});

export const upload_events = pgTable("upload_events", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  schedule_id: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
  upload_job_id: uuid("upload_job_id").references(() => upload_jobs.id, { onDelete: "set null" }),
  event_type: text("event_type").notNull(),
  payload: text("payload").notNull().default("{}"),
  created_at: text("created_at").notNull().default(sql`now()::text`),
});

export const upload_logs = pgTable("upload_logs", {
  id: uuid("id").primaryKey().$defaultFn(() => randomUUID()),
  schedule_id: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
  channel_id: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
  level: text("level").notNull(),
  message: text("message").notNull(),
  created_at: text("created_at").notNull().default(sql`now()::text`),
});
