import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, signUp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

async function createKey(token: string, name = 'Website') {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: bearer(token),
    payload: { name },
  });
  return response;
}

describe('API keys', () => {
  it('shows the key once and never again', async () => {
    const { token } = await signUp(ctx.app);
    const created = await createKey(token);
    expect(created.statusCode).toBe(201);
    const { key, prefix } = created.json();
    expect(key).toMatch(/^bk_[\w-]{32}$/);
    expect(key.startsWith(prefix)).toBe(true);

    const list = await ctx.app.inject({ url: '/v1/api-keys', headers: bearer(token) });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).not.toHaveProperty('key');
    expect(JSON.stringify(list.json())).not.toContain(key);
  });

  it('authenticates requests and stops working once revoked', async () => {
    const { token } = await signUp(ctx.app);
    const { key, id } = (await createKey(token)).json();

    const ok = await ctx.app.inject({ url: '/v1/resources', headers: { 'x-api-key': key } });
    expect(ok.statusCode).toBe(200);

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
      headers: bearer(token),
    });
    expect(revoke.statusCode).toBe(204);

    const after = await ctx.app.inject({ url: '/v1/resources', headers: { 'x-api-key': key } });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('invalid_api_key');
  });

  it('does not let an API key create more API keys', async () => {
    const { token } = await signUp(ctx.app);
    const { key } = (await createKey(token)).json();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { 'x-api-key': key },
      payload: { name: 'Sneaky' },
    });
    expect(response.statusCode).toBe(403);
  });

  it("cannot revoke another account's key", async () => {
    const owner = await signUp(ctx.app);
    const other = await signUp(ctx.app);
    const { id } = (await createKey(owner.token)).json();
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
      headers: bearer(other.token),
    });
    expect(response.statusCode).toBe(404);
  });
});
