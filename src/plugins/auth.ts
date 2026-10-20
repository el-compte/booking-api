import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { ApiError } from '../errors.js';
import { hashApiKey } from '../lib/secrets.js';

export interface AuthContext {
  accountId: ObjectId;
  method: 'jwt' | 'api_key';
  apiKeyId?: ObjectId;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    /** Accepts an API key (X-API-Key) or a user access token (Authorization: Bearer). */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Only accepts a user access token. Used for account settings such as API keys. */
    authenticateUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

/** OpenAPI security requirement for routes that use `authenticate`. */
export const anyAuth: Record<string, string[]>[] = [{ apiKeyAuth: [] }, { bearerAuth: [] }];
/** OpenAPI security requirement for routes that use `authenticateUser`. */
export const userAuth: Record<string, string[]>[] = [{ bearerAuth: [] }];

const KEY_TOUCH_INTERVAL_MS = 60_000;

/** The authenticated caller. Only call this in routes that use an auth hook. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('authOf() called on a route without an auth hook');
  return request.auth;
}

function unauthorized(reply: FastifyReply, code: string, message: string): ApiError {
  reply.header('www-authenticate', 'Bearer');
  return new ApiError(401, code, message);
}

export default fp(
  async (app) => {
    app.decorateRequest('auth', null);

    async function fromApiKey(request: FastifyRequest, reply: FastifyReply, key: string) {
      const apiKey = await app.collections.apiKeys.findOne({
        hash: hashApiKey(key),
        revokedAt: null,
      });
      if (!apiKey)
        throw unauthorized(reply, 'invalid_api_key', 'The API key is invalid or revoked');

      request.auth = { accountId: apiKey.accountId, method: 'api_key', apiKeyId: apiKey._id };

      // Record usage at most once a minute per key, without slowing the request down.
      const now = new Date();
      app.collections.apiKeys
        .updateOne(
          {
            _id: apiKey._id,
            $or: [
              { lastUsedAt: null },
              { lastUsedAt: { $lt: new Date(now.getTime() - KEY_TOUCH_INTERVAL_MS) } },
            ],
          },
          { $set: { lastUsedAt: now } },
        )
        .catch((err: unknown) => request.log.warn({ err }, 'could not update API key lastUsedAt'));
    }

    async function fromToken(request: FastifyRequest, reply: FastifyReply) {
      try {
        const { sub } = await request.jwtVerify<{ sub: string }>();
        if (!ObjectId.isValid(sub)) throw new Error('bad subject');
        request.auth = { accountId: new ObjectId(sub), method: 'jwt' };
      } catch {
        throw unauthorized(reply, 'invalid_token', 'The access token is invalid or has expired');
      }
    }

    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      const apiKey = request.headers['x-api-key'];
      if (typeof apiKey === 'string' && apiKey.length > 0)
        return fromApiKey(request, reply, apiKey);
      if (request.headers.authorization?.startsWith('Bearer ')) return fromToken(request, reply);
      throw unauthorized(
        reply,
        'unauthorized',
        'Send an API key in the X-API-Key header or an access token in the Authorization header',
      );
    });

    app.decorate('authenticateUser', async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers['x-api-key']) {
        throw new ApiError(403, 'forbidden', 'API keys cannot manage API keys. Log in instead.');
      }
      if (!request.headers.authorization?.startsWith('Bearer ')) {
        throw unauthorized(
          reply,
          'unauthorized',
          'Send an access token in the Authorization header',
        );
      }
      return fromToken(request, reply);
    });
  },
  { name: 'auth', dependencies: ['@fastify/jwt'] },
);
