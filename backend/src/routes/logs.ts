import type { FastifyRequest, FastifyReply } from 'fastify';
import { desc, sql, eq } from 'drizzle-orm';
import * as schema from '../db/schema/schema.js';
import type { App } from '../index.js';

export function registerLogsRoutes(app: App) {
  // GET /api/logs
  app.fastify.get('/api/logs', {
    schema: {
      description: 'Get upload logs',
      tags: ['logs'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 100 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            logs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  schedule_id: { type: ['string', 'null'], format: 'uuid' },
                  channel_id: { type: ['string', 'null'], format: 'uuid' },
                  level: { type: 'string' },
                  message: { type: 'string' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { limit?: number } }>, reply: FastifyReply) => {
    let { limit } = request.query;
    if (!limit) limit = 100;
    if (limit > 500) limit = 500;

    app.logger.info({ limit }, 'Fetching logs');
    const logs = await app.db
      .select()
      .from(schema.upload_logs)
      .orderBy(desc(schema.upload_logs.created_at))
      .limit(limit);

    app.logger.info({ count: logs.length }, 'Logs fetched');
    return { logs };
  });

  // GET /api/stats
  app.fastify.get('/api/stats', {
    schema: {
      description: 'Get application statistics',
      tags: ['stats'],
      response: {
        200: {
          type: 'object',
          properties: {
            total_channels: { type: 'number' },
            total_videos: { type: 'number' },
            total_scheduled: { type: 'number' },
            total_size_bytes: { type: 'number' },
            connected_channels: { type: 'number' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    app.logger.info('Fetching stats');

    const [channelCount] = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.channels);

    const [videoCount] = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.videos);

    const [scheduleCount] = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.schedules);

    const [totalSize] = await app.db
      .select({ total: sql<number>`sum(${schema.videos.size_bytes})` })
      .from(schema.videos);

    const [connectedCount] = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.channels)
      .where(eq(schema.channels.status, 'connected'));

    const stats = {
      total_channels: channelCount?.count || 0,
      total_videos: videoCount?.count || 0,
      total_scheduled: scheduleCount?.count || 0,
      total_size_bytes: totalSize?.total || 0,
      connected_channels: connectedCount?.count || 0,
    };

    app.logger.info(stats, 'Stats retrieved');
    return stats;
  });
}
