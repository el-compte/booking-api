import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { WEBHOOK_EVENTS, type WebhookDeliveryDoc, type WebhookEndpointDoc } from '../../db.js';
import { ApiError, errorResponses, notFound } from '../../errors.js';
import { idParams, toObjectId } from '../../lib/ids.js';
import { anyAuth, authOf } from '../../plugins/auth.js';
import { generateWebhookSecret } from './signing.js';
import { webhookUrlProblem } from './urls.js';

const MAX_ENDPOINTS = 10;

const endpointSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookEndpoint' });

const createdEndpointSchema = endpointSchema
  .extend({
    secret: z
      .string()
      .describe('Signing secret for the Webhook-Signature header. Shown only once, so store it.'),
  })
  .meta({ id: 'CreatedWebhookEndpoint' });

const deliverySchema = z
  .object({
    id: z.string(),
    eventId: z.string(),
    type: z.enum(WEBHOOK_EVENTS),
    status: z.enum(['pending', 'delivered', 'failed']),
    attempts: z.number().int(),
    responseStatus: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
    deliveredAt: z.iso.datetime().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'WebhookDelivery' });

const toEndpoint = (doc: WebhookEndpointDoc): z.infer<typeof endpointSchema> => ({
  id: doc._id.toHexString(),
  url: doc.url,
  events: doc.events,
  createdAt: doc.createdAt.toISOString(),
});

const toDelivery = (doc: WebhookDeliveryDoc): z.infer<typeof deliverySchema> => ({
  id: doc._id.toHexString(),
  eventId: doc.eventId,
  type: doc.type,
  status: doc.status,
  attempts: doc.attempts,
  responseStatus: doc.responseStatus,
  lastError: doc.lastError,
  createdAt: doc.createdAt.toISOString(),
  deliveredAt: doc.deliveredAt?.toISOString() ?? null,
  nextAttemptAt: doc.nextAttemptAt?.toISOString() ?? null,
});

export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const { webhookEndpoints, webhookDeliveries } = app.collections;
  const allowPrivate =
    app.config.WEBHOOK_ALLOW_PRIVATE_URLS ?? app.config.NODE_ENV !== 'production';
  app.addHook('onRequest', app.authenticate);

  async function findEndpoint(accountId: ObjectId, id: string) {
    const endpoint = await webhookEndpoints.findOne({ _id: toObjectId(id), accountId });
    if (!endpoint) throw notFound('Webhook endpoint');
    return endpoint;
  }

  app.post(
    '/webhook-endpoints',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Subscribe a URL to booking events',
        description:
          'Each event is sent as a signed POST. Failed deliveries are retried after 30s, 2m, 10m, 1h and 6h.',
        security: anyAuth,
        body: z.object({
          url: z.url().max(2000).meta({ example: 'https://example.com/hooks/bookings' }),
          events: z
            .array(z.enum(WEBHOOK_EVENTS))
            .min(1)
            .default([...WEBHOOK_EVENTS])
            .describe('Defaults to every event'),
        }),
        response: { 201: createdEndpointSchema, ...errorResponses(400, 401, 409, 429) },
      },
    },
    async (request, reply) => {
      const { accountId } = authOf(request);
      const problem = webhookUrlProblem(request.body.url, { allowPrivate });
      if (problem) {
        throw new ApiError(400, 'invalid_webhook_url', `url ${problem}`, [
          { path: 'body.url', message: problem },
        ]);
      }
      if ((await webhookEndpoints.countDocuments({ accountId })) >= MAX_ENDPOINTS) {
        throw new ApiError(
          409,
          'too_many_endpoints',
          `Delete an endpoint first (limit ${MAX_ENDPOINTS})`,
        );
      }
      const doc: WebhookEndpointDoc = {
        _id: new ObjectId(),
        accountId,
        url: request.body.url,
        events: [...new Set(request.body.events)],
        secret: generateWebhookSecret(),
        createdAt: new Date(),
      };
      await webhookEndpoints.insertOne(doc);
      return reply.status(201).send({ ...toEndpoint(doc), secret: doc.secret });
    },
  );

  app.get(
    '/webhook-endpoints',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'List webhook endpoints',
        security: anyAuth,
        response: {
          200: z.object({ data: z.array(endpointSchema) }),
          ...errorResponses(401, 429),
        },
      },
    },
    async (request) => {
      const docs = await webhookEndpoints
        .find({ accountId: authOf(request).accountId })
        .sort({ createdAt: -1 })
        .toArray();
      return { data: docs.map(toEndpoint) };
    },
  );

  app.delete(
    '/webhook-endpoints/:id',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Delete a webhook endpoint',
        description: 'Pending deliveries to it are dropped.',
        security: anyAuth,
        params: idParams,
        response: { 204: z.null(), ...errorResponses(400, 401, 404, 429) },
      },
    },
    async (request, reply) => {
      const endpoint = await findEndpoint(authOf(request).accountId, request.params.id);
      await webhookEndpoints.deleteOne({ _id: endpoint._id });
      await webhookDeliveries.updateMany(
        { endpointId: endpoint._id, status: 'pending' },
        { $set: { status: 'failed', lastError: 'endpoint was deleted', nextAttemptAt: null } },
      );
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/webhook-endpoints/:id/deliveries',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Recent deliveries to an endpoint',
        description: 'The 50 most recent deliveries, newest first. History is kept for 30 days.',
        security: anyAuth,
        params: idParams,
        response: {
          200: z.object({ data: z.array(deliverySchema) }),
          ...errorResponses(400, 401, 404, 429),
        },
      },
    },
    async (request) => {
      const endpoint = await findEndpoint(authOf(request).accountId, request.params.id);
      const docs = await webhookDeliveries
        .find({ endpointId: endpoint._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      return { data: docs.map(toDelivery) };
    },
  );
};
