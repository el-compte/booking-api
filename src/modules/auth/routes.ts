import bcrypt from 'bcryptjs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { type AccountDoc, duplicateKeyIndex } from '../../db.js';
import { ApiError, errorResponses } from '../../errors.js';
import { anyAuth, authOf } from '../../plugins/auth.js';

const accountSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Account' });

const sessionSchema = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().describe('Seconds until the access token expires'),
    account: accountSchema,
  })
  .meta({ id: 'Session' });

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'must be at least 10 characters').max(128),
});

const toAccount = (doc: AccountDoc): z.infer<typeof accountSchema> => ({
  id: doc._id.toHexString(),
  email: doc.email,
  name: doc.name,
  createdAt: doc.createdAt.toISOString(),
});

// Compared against when the email is unknown, so both cases take the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { accounts } = app.collections;
  const authRateLimit = { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' };

  const session = async (account: AccountDoc) => ({
    accessToken: await app.jwt.sign({ sub: account._id.toHexString() }),
    tokenType: 'Bearer' as const,
    expiresIn: app.config.JWT_TTL_SECONDS,
    account: toAccount(account),
  });

  app.post(
    '/auth/signup',
    {
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Auth'],
        summary: 'Create an account',
        body: credentials.extend({ name: z.string().trim().min(1).max(100) }),
        response: { 201: sessionSchema, ...errorResponses(400, 409, 429) },
      },
    },
    async (request, reply) => {
      const account: AccountDoc = {
        _id: new ObjectId(),
        email: request.body.email.toLowerCase(),
        name: request.body.name,
        passwordHash: await bcrypt.hash(request.body.password, app.config.BCRYPT_ROUNDS),
        createdAt: new Date(),
      };
      try {
        await accounts.insertOne(account);
      } catch (error) {
        if (duplicateKeyIndex(error)) {
          throw new ApiError(409, 'email_taken', 'An account with this email already exists');
        }
        throw error;
      }
      return reply.status(201).send(await session(account));
    },
  );

  app.post(
    '/auth/login',
    {
      config: { rateLimit: authRateLimit },
      schema: {
        tags: ['Auth'],
        summary: 'Log in and get an access token',
        body: credentials.extend({ password: z.string().min(1).max(128) }),
        response: { 200: sessionSchema, ...errorResponses(400, 401, 429) },
      },
    },
    async (request) => {
      const account = await accounts.findOne({ email: request.body.email.toLowerCase() });
      const valid = await bcrypt.compare(
        request.body.password,
        account?.passwordHash ?? DUMMY_HASH,
      );
      if (!account || !valid) {
        throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
      }
      return session(account);
    },
  );

  app.get(
    '/me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['Auth'],
        summary: 'Get the current account',
        security: anyAuth,
        response: { 200: accountSchema, ...errorResponses(401, 429) },
      },
    },
    async (request) => {
      const account = await accounts.findOne({ _id: authOf(request).accountId });
      if (!account) throw new ApiError(401, 'invalid_token', 'The account no longer exists');
      return toAccount(account);
    },
  );
};
