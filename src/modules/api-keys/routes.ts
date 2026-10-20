import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import type { ApiKeyDoc } from '../../db.js';
import { ApiError, errorResponses, notFound } from '../../errors.js';
import { idParams, toObjectId } from '../../lib/ids.js';
import { generateApiKey } from '../../lib/secrets.js';
import { authOf, userAuth } from '../../plugins/auth.js';

const MAX_ACTIVE_KEYS = 20;

const apiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().describe('First characters of the key, to tell keys apart'),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ApiKey' });

const createdApiKeySchema = apiKeySchema
  .extend({ key: z.string().describe('The full key. It is only shown once, so store it now.') })
  .meta({ id: 'CreatedApiKey' });

const toApiKey = (doc: ApiKeyDoc): z.infer<typeof apiKeySchema> => ({
  id: doc._id.toHexString(),
  name: doc.name,
  prefix: doc.prefix,
  createdAt: doc.createdAt.toISOString(),
  lastUsedAt: doc.lastUsedAt?.toISOString() ?? null,
  revokedAt: doc.revokedAt?.toISOString() ?? null,
});

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const { apiKeys } = app.collections;
  app.addHook('onRequest', app.authenticateUser);

  app.post(
    '/api-keys',
    {
      schema: {
        tags: ['API keys'],
        summary: 'Create an API key',
        description:
          'Requires a user access token. The full key is returned only in this response.',
        security: userAuth,
        body: z.object({ name: z.string().trim().min(1).max(100) }),
        response: { 201: createdApiKeySchema, ...errorResponses(400, 401, 403, 409, 429) },
      },
    },
    async (request, reply) => {
      const { accountId } = authOf(request);
      const active = await apiKeys.countDocuments({ accountId, revokedAt: null });
      if (active >= MAX_ACTIVE_KEYS) {
        throw new ApiError(
          409,
          'too_many_api_keys',
          `Revoke a key first (limit ${MAX_ACTIVE_KEYS})`,
        );
      }
      const { key, prefix, hash } = generateApiKey();
      const doc: ApiKeyDoc = {
        _id: new ObjectId(),
        accountId,
        name: request.body.name,
        prefix,
        hash,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      };
      await apiKeys.insertOne(doc);
      return reply.status(201).send({ ...toApiKey(doc), key });
    },
  );

  app.get(
    '/api-keys',
    {
      schema: {
        tags: ['API keys'],
        summary: 'List API keys',
        security: userAuth,
        response: {
          200: z.object({ data: z.array(apiKeySchema) }),
          ...errorResponses(401, 403, 429),
        },
      },
    },
    async (request) => {
      const docs = await apiKeys
        .find({ accountId: authOf(request).accountId })
        .sort({ createdAt: -1 })
        .toArray();
      return { data: docs.map(toApiKey) };
    },
  );

  app.delete(
    '/api-keys/:id',
    {
      schema: {
        tags: ['API keys'],
        summary: 'Revoke an API key',
        security: userAuth,
        params: idParams,
        response: { 204: z.null(), ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const filter = { _id: toObjectId(request.params.id), accountId: authOf(request).accountId };
      const result = await apiKeys.updateOne(
        { ...filter, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      if (result.matchedCount === 0 && !(await apiKeys.findOne(filter))) {
        throw notFound('API key');
      }
      return reply.status(204).send(null);
    },
  );
};
