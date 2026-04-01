import { mkdir, rm } from "node:fs/promises";
import fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { getEnv } from "../config/env.js";
import * as schema from "../db/schema/schema.js";

export type App = {
  fastify: ReturnType<typeof fastify>;
  db: any;
  logger: ReturnType<typeof fastify>["log"];
  env: ReturnType<typeof getEnv>;
  run: () => Promise<void>;
};

export async function createCoreApp(): Promise<App> {
  const env = getEnv();
  const app = fastify({
    logger: {
      level: env.logLevel,
      transport:
        env.nodeEnv === "development"
          ? {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
            }
          : undefined,
    },
  });
  await app.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute",
  });

  let db: any;
  if (env.databaseUrl) {
    const sql = postgres(env.databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 10 });
    db = drizzlePostgres(sql, { schema });
    app.log.info("Database mode: postgres");
  } else {
    await mkdir(env.pglitePath, { recursive: true });
    await rm(`${env.pglitePath}/postmaster.pid`, { force: true }).catch(() => undefined);
    await rm(`${env.pglitePath}/.s.PGSQL.5432.lock.out`, { force: true }).catch(() => undefined);
    const sqlite = new PGlite(env.pglitePath);
    db = drizzlePgLite(sqlite, { schema });
    app.log.info({ pglitePath: env.pglitePath }, "Database mode: pglite fallback");
  }

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, "Unhandled API error");
    reply.status(500).send({ error: "Internal server error" });
  });

  return {
    fastify: app,
    db,
    logger: app.log,
    env,
    run: async () => {
      await app.listen({ host: env.host, port: env.port });
      app.log.info({ host: env.host, port: env.port }, "API listening");
    },
  };
}
