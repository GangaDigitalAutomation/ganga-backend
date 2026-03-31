import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import * as schema from '../db/schema/schema.js';
import type { App } from '../index.js';

type OAuthValidateBody = {
  oauth_json_text?: string;
  oauth_json?: unknown;
};

function extractOAuthClient(jsonInput: unknown) {
  const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON: root object is required');
  }

  const root = parsed as Record<string, unknown>;
  const source = (root.web || root.installed) as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') {
    throw new Error('Invalid OAuth JSON: expected "web" or "installed" object');
  }

  const client_id = String(source.client_id || '').trim();
  const client_secret = String(source.client_secret || '').trim();
  if (!client_id || !client_secret) {
    throw new Error('Invalid OAuth JSON: client_id and client_secret are required');
  }

  return {
    client_id,
    client_secret,
    project_id: String(source.project_id || '').trim() || null,
    client_type: root.web ? 'web' : 'installed',
  };
}

export function registerChannelRoutes(app: App) {
  // POST /api/channels/oauth-json/validate
  app.fastify.post('/api/channels/oauth-json/validate', {
    schema: {
      description: 'Validate Google OAuth client JSON and extract required fields',
      tags: ['channels'],
      body: {
        type: 'object',
        properties: {
          oauth_json_text: { type: 'string' },
          oauth_json: { type: ['object', 'string'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
            project_id: { type: ['string', 'null'] },
            client_type: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: OAuthValidateBody }>, reply: FastifyReply) => {
    try {
      const body = request.body || {};
      const raw = body.oauth_json_text || body.oauth_json;
      if (!raw) {
        return reply.status(400).send({ error: 'Missing oauth_json_text or oauth_json' });
      }
      const extracted = extractOAuthClient(raw);
      return { valid: true, ...extracted };
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Invalid OAuth JSON' });
    }
  });

  // GET /api/channels
  app.fastify.get('/api/channels', {
    schema: {
      description: 'Get all channels',
      tags: ['channels'],
      response: {
        200: {
          type: 'object',
          properties: {
            channels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  client_id: { type: 'string' },
                  client_secret: { type: 'string' },
                  access_token: { type: ['string', 'null'] },
                  refresh_token: { type: ['string', 'null'] },
                  token_expiry: { type: ['string', 'null'] },
                  youtube_channel_id: { type: ['string', 'null'] },
                  youtube_channel_url: { type: ['string', 'null'] },
                  is_starred: { type: 'boolean' },
                  status: { type: 'string' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    app.logger.info('Fetching all channels');
    const channels = await app.db
      .select()
      .from(schema.channels)
      .orderBy(desc(schema.channels.is_starred), desc(schema.channels.created_at));
    app.logger.info({ count: channels.length }, 'Channels fetched');
    return { channels };
  });

  // POST /api/channels
  app.fastify.post('/api/channels', {
    schema: {
      description: 'Create a new channel',
      tags: ['channels'],
      body: {
        type: 'object',
        required: ['name', 'client_id', 'client_secret'],
        properties: {
          name: { type: 'string' },
          client_id: { type: 'string' },
          client_secret: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
            access_token: { type: ['string', 'null'] },
            refresh_token: { type: ['string', 'null'] },
            token_expiry: { type: ['string', 'null'] },
            youtube_channel_id: { type: ['string', 'null'] },
            youtube_channel_url: { type: ['string', 'null'] },
            is_starred: { type: 'boolean' },
            status: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: { name: string; client_id: string; client_secret: string } }>, reply: FastifyReply) => {
    const { name, client_id, client_secret } = request.body;
    app.logger.info({ name, client_id }, 'Creating channel');
    const [channel] = await app.db
      .insert(schema.channels)
      .values({
        name,
        client_id,
        client_secret,
        status: 'disconnected',
        is_starred: false,
        created_at: new Date().toISOString(),
      })
      .returning();
    app.logger.info({ channelId: channel.id }, 'Channel created');
    reply.status(201);
    return channel;
  });

  // GET /api/channels/:id
  app.fastify.get('/api/channels/:id', {
    schema: {
      description: 'Get a channel by ID',
      tags: ['channels'],
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
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
            access_token: { type: ['string', 'null'] },
            refresh_token: { type: ['string', 'null'] },
            token_expiry: { type: ['string', 'null'] },
            youtube_channel_id: { type: ['string', 'null'] },
            youtube_channel_url: { type: ['string', 'null'] },
            is_starred: { type: 'boolean' },
            status: { type: 'string' },
            created_at: { type: 'string' },
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
    app.logger.info({ channelId: id }, 'Fetching channel');
    const channel = await app.db.query.channels.findFirst({
      where: eq(schema.channels.id, id),
    });
    if (!channel) {
      app.logger.warn({ channelId: id }, 'Channel not found');
      return reply.status(404).send({ error: 'Channel not found' });
    }
    return channel;
  });

  // PUT /api/channels/:id
  app.fastify.put('/api/channels/:id', {
    schema: {
      description: 'Update a channel',
      tags: ['channels'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          is_starred: { type: 'boolean' },
          access_token: { type: ['string', 'null'] },
          refresh_token: { type: ['string', 'null'] },
          token_expiry: { type: ['string', 'null'] },
          youtube_channel_id: { type: ['string', 'null'] },
          youtube_channel_url: { type: ['string', 'null'] },
          status: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
            access_token: { type: ['string', 'null'] },
            refresh_token: { type: ['string', 'null'] },
            token_expiry: { type: ['string', 'null'] },
            youtube_channel_id: { type: ['string', 'null'] },
            youtube_channel_url: { type: ['string', 'null'] },
            is_starred: { type: 'boolean' },
            status: { type: 'string' },
            created_at: { type: 'string' },
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
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: Partial<{ name: string; is_starred: boolean; access_token: string | null; refresh_token: string | null; token_expiry: string | null; youtube_channel_id: string | null; youtube_channel_url: string | null; status: string }> }>, reply: FastifyReply) => {
    const { id } = request.params;
    const updates = request.body;
    app.logger.info({ channelId: id, updates }, 'Updating channel');

    const channel = await app.db.query.channels.findFirst({
      where: eq(schema.channels.id, id),
    });
    if (!channel) {
      app.logger.warn({ channelId: id }, 'Channel not found');
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const updateData: any = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.is_starred !== undefined) updateData.is_starred = updates.is_starred;
    if (updates.access_token !== undefined) updateData.access_token = updates.access_token;
    if (updates.refresh_token !== undefined) updateData.refresh_token = updates.refresh_token;
    if (updates.token_expiry !== undefined) updateData.token_expiry = updates.token_expiry;
    if (updates.youtube_channel_id !== undefined) updateData.youtube_channel_id = updates.youtube_channel_id;
    if (updates.youtube_channel_url !== undefined) updateData.youtube_channel_url = updates.youtube_channel_url;
    if (updates.status !== undefined) updateData.status = updates.status;

    const [updated] = await app.db
      .update(schema.channels)
      .set(updateData)
      .where(eq(schema.channels.id, id))
      .returning();

    app.logger.info({ channelId: id }, 'Channel updated');
    return updated;
  });

  // DELETE /api/channels/:id
  app.fastify.delete('/api/channels/:id', {
    schema: {
      description: 'Delete a channel',
      tags: ['channels'],
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
    app.logger.info({ channelId: id }, 'Deleting channel');

    const channel = await app.db.query.channels.findFirst({
      where: eq(schema.channels.id, id),
    });
    if (!channel) {
      app.logger.warn({ channelId: id }, 'Channel not found');
      return reply.status(404).send({ error: 'Channel not found' });
    }

    await app.db.delete(schema.channels).where(eq(schema.channels.id, id));
    app.logger.info({ channelId: id }, 'Channel deleted');
    return { success: true };
  });

  // GET /api/channels/:id/oauth-url
  app.fastify.get('/api/channels/:id/oauth-url', {
    schema: {
      description: 'Get OAuth URL for channel',
      tags: ['channels'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        required: ['redirect_uri'],
        properties: {
          redirect_uri: { type: 'string' },
          state: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            url: { type: 'string' },
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
  }, async (request: FastifyRequest<{ Params: { id: string }; Querystring: { redirect_uri: string; state?: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const { redirect_uri, state } = request.query;
    app.logger.info({ channelId: id }, 'Building OAuth URL');

    const channel = await app.db.query.channels.findFirst({
      where: eq(schema.channels.id, id),
    });
    if (!channel) {
      app.logger.warn({ channelId: id }, 'Channel not found');
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const params = new URLSearchParams({
      client_id: channel.client_id,
      redirect_uri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/drive.readonly',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    if (state) {
      params.set('state', state);
    }

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    app.logger.info({ channelId: id }, 'OAuth URL generated');
    return { url };
  });

  // POST /api/channels/:id/oauth-callback
  app.fastify.post('/api/channels/:id/oauth-callback', {
    schema: {
      description: 'Handle OAuth callback for channel',
      tags: ['channels'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['code', 'redirect_uri'],
        properties: {
          code: { type: 'string' },
          redirect_uri: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
            access_token: { type: ['string', 'null'] },
            refresh_token: { type: ['string', 'null'] },
            token_expiry: { type: ['string', 'null'] },
            youtube_channel_id: { type: ['string', 'null'] },
            youtube_channel_url: { type: ['string', 'null'] },
            is_starred: { type: 'boolean' },
            status: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: { code: string; redirect_uri: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const { code, redirect_uri } = request.body;
    app.logger.info({ channelId: id }, 'Processing OAuth callback');

    const channel = await app.db.query.channels.findFirst({
      where: eq(schema.channels.id, id),
    });
    if (!channel) {
      app.logger.warn({ channelId: id }, 'Channel not found');
      return reply.status(404).send({ error: 'Channel not found' });
    }

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: channel.client_id,
          client_secret: channel.client_secret,
          redirect_uri,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenResponse.ok) {
        throw new Error('Failed to exchange code for tokens');
      }

      const tokenData = await tokenResponse.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
      console.log("TOKEN SCOPES:", tokenData.scope || '');
      const token_expiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

      // Get YouTube channel info
      const channelResponse = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }
      );

      if (!channelResponse.ok) {
        throw new Error('Failed to fetch YouTube channel info');
      }

      const channelData = await channelResponse.json() as { items: Array<{ id: string }> };
      const youtube_channel_id = channelData.items[0]?.id;

      if (!youtube_channel_id) {
        throw new Error('YouTube channel ID not found');
      }

      const youtube_channel_url = `https://youtube.com/channel/${youtube_channel_id}`;

      // Update channel
      const [updated] = await app.db
        .update(schema.channels)
        .set({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || channel.refresh_token,
          token_expiry,
          youtube_channel_id,
          youtube_channel_url,
          status: 'connected',
        })
        .where(eq(schema.channels.id, id))
        .returning();

      // Log success
      await app.db.insert(schema.upload_logs).values({
        channel_id: id,
        level: 'info',
        message: `Channel connected: ${channel.name}`,
        created_at: new Date().toISOString(),
      });

      app.logger.info({ channelId: id, youtubeChannelId: youtube_channel_id }, 'OAuth callback processed successfully');
      return updated;
    } catch (error) {
      app.logger.error({ err: error, channelId: id }, 'OAuth callback failed');
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'OAuth callback failed' });
    }
  });
}
