import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe('OpenAPI docs', () => {
  it('documents every versioned route with its security', async () => {
    const response = await ctx.app.inject({ url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/v1/api-keys',
      '/v1/api-keys/{id}',
      '/v1/auth/login',
      '/v1/auth/signup',
      '/v1/bookings',
      '/v1/bookings/{id}',
      '/v1/bookings/{id}/cancel',
      '/v1/bookings/{id}/reschedule',
      '/v1/me',
      '/v1/resources',
      '/v1/resources/{id}',
      '/v1/resources/{id}/availability',
      '/v1/webhook-endpoints',
      '/v1/webhook-endpoints/{id}',
      '/v1/webhook-endpoints/{id}/deliveries',
    ]);
    expect(spec.paths['/v1/bookings'].post.security).toEqual([
      { apiKeyAuth: [] },
      { bearerAuth: [] },
    ]);
    expect(spec.components.schemas).toHaveProperty('Booking');
    expect(spec.components.schemas).toHaveProperty('Error');
  });

  it('serves the interactive docs page', async () => {
    const response = await ctx.app.inject({ url: '/docs' });
    expect([200, 302]).toContain(response.statusCode);
  });
});
