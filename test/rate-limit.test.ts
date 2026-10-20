import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
