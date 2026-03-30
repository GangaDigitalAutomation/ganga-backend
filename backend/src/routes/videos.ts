import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import * as schema from '../db/schema/schema.js';
import type { App } from '../index.js';

export function registerVideoRoutes(app: App) {
  // GET /api/videos
  app.fastify.get('/api/videos', {
    schema: {
      description: 'Get all videos',
      tags: ['videos'],
      response: {
        200: {
          type: 'object',
          properties: {
            videos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  file_path: { type: 'string' },
                  size_bytes: { type: 'number' },
                  extension: { type: 'string' },
                  created_at: { type: 'string' },
                },
              },
            },
            total_size_bytes: { type: 'number' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    app.logger.info('Fetching all videos');
    const videos = await app.db
      .select()
      .from(schema.videos)
      .orderBy(desc(schema.videos.created_at));

    const result = await app.db.select({ total: sql<number>`sum(${schema.videos.size_bytes})` }).from(schema.videos);
    const total_size_bytes = result[0]?.total || 0;

    app.logger.info({ count: videos.length, totalBytes: total_size_bytes }, 'Videos fetched');
    return { videos, total_size_bytes };
  });

  // POST /api/videos
  app.fastify.post('/api/videos', {
    schema: {
      description: 'Bulk insert videos',
      tags: ['videos'],
      body: {
        type: 'object',
        required: ['videos'],
        properties: {
          videos: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'file_path', 'size_bytes', 'extension'],
              properties: {
                name: { type: 'string' },
                file_path: { type: 'string' },
                size_bytes: { type: 'number' },
                extension: { type: 'string' },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            videos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  file_path: { type: 'string' },
                  size_bytes: { type: 'number' },
                  extension: { type: 'string' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: { videos: Array<{ name: string; file_path: string; size_bytes: number; extension: string }> } }>, reply: FastifyReply) => {
    const { videos: videoList } = request.body;
    app.logger.info({ count: videoList.length }, 'Bulk inserting videos');

    const now = new Date().toISOString();
    const inserted = await app.db
      .insert(schema.videos)
      .values(
        videoList.map(v => ({
          ...v,
          created_at: now,
        }))
      )
      .returning();

    app.logger.info({ count: inserted.length }, 'Videos inserted');
    reply.status(201);
    return { videos: inserted };
  });

  // DELETE /api/videos (delete all) - MUST be before DELETE /api/videos/:id
  app.fastify.delete('/api/videos', {
    schema: {
      description: 'Delete all videos',
      tags: ['videos'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    app.logger.info('Deleting all videos');
    await app.db.delete(schema.videos);
    app.logger.info('All videos deleted');
    return { success: true };
  });

  // DELETE /api/videos/:id
  app.fastify.delete('/api/videos/:id', {
    schema: {
      description: 'Delete a video by ID',
      tags: ['videos'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    app.logger.info({ videoId: id }, 'Deleting video');

    const video = await app.db.query.videos.findFirst({
      where: eq(schema.videos.id, id),
    });
    if (!video) {
      app.logger.warn({ videoId: id }, 'Video not found');
      return reply.status(404).send({ error: 'Video not found' });
    }

    await app.db.delete(schema.videos).where(eq(schema.videos.id, id));
    app.logger.info({ videoId: id }, 'Video deleted');
    return { success: true };
  });
}
