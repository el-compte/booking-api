import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const signup = (payload: object) =>
  ctx.app.inject({ method: 'POST', url: '/v1/auth/signup', payload });

describe('auth', () => {
  it('signs up, logs in and returns the account', async () => {
    const created = await signup({
      email: 'Owner@Example.com',
      password: 'a-long-password',
      name: 'Owner',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      tokenType: 'Bearer',
      account: { email: 'owner@example.com' },
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'a-long-password' },
    });
    expect(login.statusCode).toBe(200);

    const me = await ctx.app.inject({ url: '/v1/me', headers: bearer(login.json().accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'owner@example.com', name: 'Owner' });
  });

  it('rejects a duplicate email', async () => {
    const payload = { email: 'dup@example.com', password: 'a-long-password', name: 'Dup' };
    await signup(payload);
    const second = await signup({ ...payload, email: 'DUP@example.com' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('email_taken');
  });

  it('rejects a wrong password without saying whether the email exists', async () => {
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'not-the-password' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('explains validation errors field by field', async () => {
    const response = await signup({ email: 'not-an-email', password: 'short', name: '' });
    expect(response.statusCode).toBe(400);
    const { error } = response.json();
    expect(error.code).toBe('validation_error');
    expect(error.requestId).toBe(response.headers['x-request-id']);
    expect(error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'body.email',
      'body.name',
      'body.password',
    ]);
  });

  it('requires credentials and rejects bad tokens', async () => {
    const missing = await ctx.app.inject({ url: '/v1/me' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const bad = await ctx.app.inject({ url: '/v1/me', headers: bearer('not.a.jwt') });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_token');
  });

  it('returns a JSON error for unknown routes', async () => {
    const { token } = await signUp(ctx.app);
    const response = await ctx.app.inject({ url: '/v1/nope', headers: bearer(token) });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('route_not_found');
  });
});
