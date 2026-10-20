import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { bearer, createTestApp, signUp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp({ RATE_LIMIT_MAX: '3', AUTH_RATE_LIMIT_MAX: '5' });
});
afterAll(() => ctx.close());

describe('rate limiting', () => {
  it('limits each account separately and explains when to retry', async () => {
    const first = await signUp(ctx.app);
    const second = await signUp(ctx.app);
    const call = (token: string) =>
      ctx.app.inject({ url: '/v1/resources', headers: bearer(token) });

    const ok = await call(first.token);
    expect(ok.headers['x-ratelimit-limit']).toBe('3');
    expect(ok.headers['x-ratelimit-remaining']).toBe('2');
    await call(first.token);
    await call(first.token);

    const limited = await call(first.token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();

    expect((await call(second.token)).statusCode).toBe(200);
  });

  it('never limits the health check', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await ctx.app.inject({ url: '/health' })).statusCode).toBe(200);
    }
  });
});

/**
 * With several API instances behind a load balancer, in-memory counters would let a client
 * make RATE_LIMIT_MAX requests per instance. A shared Redis store makes the limit global.
 */
async function expectSharedLimit(redis: Redis) {
  const first = await createTestApp({ RATE_LIMIT_MAX: '3' }, { redis });
  const second = await buildApp({ config: first.app.config, db: first.db, redis });
  try {
    const { token } = await signUp(first.app);
    const call = (app: typeof first.app) =>
      app.inject({ url: '/v1/resources', headers: bearer(token) });

    expect((await call(first.app)).statusCode).toBe(200);
    expect((await call(second)).statusCode).toBe(200);
    expect((await call(first.app)).statusCode).toBe(200);
    // The fourth request is limited, even though each instance only saw two.
    const limited = await call(second);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
  } finally {
    await second.close();
    await first.close();
  }
}

describe('rate limiting with a shared Redis store', () => {
  it('counts requests across instances (ioredis-mock)', async () => {
    await expectSharedLimit(new RedisMock() as unknown as Redis);
  });

  it.skipIf(!process.env.REDIS_URL)('counts requests across instances (real Redis)', async () => {
    const redis = new Redis(process.env.REDIS_URL ?? '');
    try {
      await expectSharedLimit(redis);
    } finally {
      await redis.quit();
    }
  });
});
