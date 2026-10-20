import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Db } from 'mongodb';
import { z } from 'zod';
import type { Config } from './config.js';
import { type Collections, getCollections } from './db.js';
import { ApiError, errorHandler } from './errors.js';
import { apiKeyRoutes } from './modules/api-keys/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { bookingRoutes } from './modules/bookings/routes.js';
import { mcpRoutes } from './modules/mcp/routes.js';
import { resourceRoutes } from './modules/resources/routes.js';
import { createWebhookDispatcher, type WebhookDispatcher } from './modules/webhooks/dispatcher.js';
import { webhookRoutes } from './modules/webhooks/routes.js';
import authPlugin from './plugins/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    collections: Collections;
    webhooks: WebhookDispatcher;
  }
}

export interface AppOptions {
  config: Config;
  db: Db;
  /** Shared rate-limit store. Without it, limits are counted in memory per instance. */
  redis?: Redis | null;
}

const API_DESCRIPTION = `
Book time slots on resources such as rooms, staff members or equipment.

**Authentication.** Create an account with \`POST /v1/auth/signup\`, then create an API key
with \`POST /v1/api-keys\` and send it in the \`X-API-Key\` header. Access tokens from login
also work, in \`Authorization: Bearer <token>\`.

**Errors** always look like \`{ "error": { "code", "message", "details?", "requestId" } }\`.

**Webhooks** notify your servers when bookings are created, cancelled or rescheduled. Each
request is signed: verify \`Webhook-Signature\` (\`t=<unix time>,v1=<HMAC-SHA256 of "t.body">\`)
with your endpoint secret.

**AI assistants** can use this API through its MCP server at \`/mcp\` (Streamable HTTP), with the
same API key.

**Rate limits** are per account (or per IP before you log in). Every response carries
\`x-ratelimit-limit\`, \`x-ratelimit-remaining\` and \`x-ratelimit-reset\`; a \`429\` also has
\`retry-after\`.
`.trim();

function logger(config: Config): FastifyServerOptions['logger'] {
  if (config.NODE_ENV === 'development') {
    return { level: config.LOG_LEVEL, transport: { target: 'pino-pretty' } };
  }
  return { level: config.LOG_LEVEL };
}

export async function buildApp({ config, db, redis = null }: AppOptions) {
  const app = Fastify({
    logger: logger(config),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: config.NODE_ENV === 'production',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request) => {
    throw new ApiError(404, 'route_not_found', `No route for ${request.method} ${request.url}`);
  });

  app.decorate('config', config);
  app.decorate('collections', getCollections(db));
  app.decorate(
    'webhooks',
    createWebhookDispatcher({
      collections: app.collections,
      log: app.log,
      allowPrivateUrls: config.WEBHOOK_ALLOW_PRIVATE_URLS ?? config.NODE_ENV !== 'production',
    }),
  );
  app.addHook('onClose', async () => app.webhooks.stop());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(','),
    exposedHeaders: [
      'location',
      'retry-after',
      'x-request-id',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'idempotent-replayed',
    ],
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    // Run after authentication so limits apply per account rather than per IP.
    hook: 'preHandler',
    keyGenerator: (request) =>
      request.auth ? `account:${request.auth.accountId.toHexString()}` : `ip:${request.ip}`,
    allowList: (request) => request.url === '/health' || request.url.startsWith('/docs'),
    // With Redis, every instance shares the same counters. If Redis is down, let requests
    // through rather than failing them.
    ...(redis ? { redis, nameSpace: 'booking-api:rate-limit:', skipOnError: true } : {}),
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Booking API', version: '1.0.0', description: API_DESCRIPTION },
      servers: [{ url: config.PUBLIC_URL ?? `http://localhost:${config.PORT}` }],
      tags: [
        { name: 'Auth', description: 'Accounts and access tokens' },
        { name: 'API keys', description: 'Keys for server-to-server access' },
        { name: 'Resources', description: 'Things that can be booked, and their free slots' },
        { name: 'Bookings', description: 'Reservations on a resource' },
        { name: 'Webhooks', description: 'Get notified when bookings change' },
      ],
      components: {
        securitySchemes: {
          apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_TTL_SECONDS },
  });
  await app.register(authPlugin);

  app.get(
    '/health',
    {
      schema: {
        hide: true,
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => {
      await db.command({ ping: 1 });
      return { status: 'ok' as const };
    },
  );

  app.get('/', { schema: { hide: true } }, async (_request, reply) => reply.redirect('/docs'));

  await app.register(mcpRoutes);

  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(apiKeyRoutes);
      await v1.register(resourceRoutes);
      await v1.register(bookingRoutes);
      await v1.register(webhookRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
