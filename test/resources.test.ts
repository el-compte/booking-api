import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  at,
  bearer,
  createResource,
  createTestApp,
  nextMonday,
  signUp,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe('resources', () => {
  it('creates a resource with weekday 9 to 5 opening hours by default', async () => {
    const { token } = await signUp(ctx.app);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: bearer(token),
      payload: { name: 'Chair 1', timezone: 'Europe/Paris' },
    });
    expect(response.statusCode).toBe(201);
    const resource = response.json();
    expect(response.headers.location).toBe(`/v1/resources/${resource.id}`);
    expect(resource.slotMinutes).toBe(30);
    expect(resource.openingHours.monday).toEqual([{ from: '09:00', to: '17:00' }]);
    expect(resource.openingHours.sunday).toEqual([]);
  });

  it.each([
    ['an unknown time zone', { timezone: 'Mars/Olympus' }, 'body.timezone'],
    ['a slot length that is not allowed', { slotMinutes: 25 }, 'body.slotMinutes'],
    [
      'overlapping opening hours',
      {
        openingHours: {
          monday: [
            { from: '09:00', to: '12:00' },
            { from: '11:00', to: '14:00' },
          ],
        },
      },
      'body.openingHours.monday',
    ],
    [
      'times off the quarter hour',
      { openingHours: { monday: [{ from: '09:10', to: '12:00' }] } },
      'body.openingHours.monday.0.from',
    ],
  ])('rejects %s', async (_label, overrides, path) => {
    const { token } = await signUp(ctx.app);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: bearer(token),
      payload: { name: 'Bad', timezone: 'Europe/Paris', ...overrides },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it("hides other accounts' resources", async () => {
    const owner = await signUp(ctx.app);
    const other = await signUp(ctx.app);
    const resource = await createResource(ctx.app, owner.token);
    const response = await ctx.app.inject({
      url: `/v1/resources/${resource.id}`,
      headers: bearer(other.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it('updates a resource', async () => {
    const { token } = await signUp(ctx.app);
    const resource = await createResource(ctx.app, token);
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/resources/${resource.id}`,
      headers: bearer(token),
      payload: { name: 'Room B', slotMinutes: 60 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Room B', slotMinutes: 60 });
  });

  it('stores client metadata and replaces it on update', async () => {
    const { token } = await signUp(ctx.app);
    const metadata = {
      city: 'Lyon',
      pricePerHour: 45,
      featured: true,
      images: ['https://a/1.jpg'],
    };
    const resource = await createResource(ctx.app, token, { metadata });
    const fetched = await ctx.app.inject({
      url: `/v1/resources/${resource.id}`,
      headers: bearer(token),
    });
    expect(fetched.json().metadata).toEqual(metadata);

    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/resources/${resource.id}`,
      headers: bearer(token),
      payload: { metadata: { city: 'Paris' } },
    });
    expect(updated.json().metadata).toEqual({ city: 'Paris' });

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/resources',
      headers: bearer(token),
      payload: {
        name: 'Bad',
        timezone: 'Europe/Paris',
        metadata: { 'bad key!': 1, nested: { a: 1 } },
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('pages through resources with a cursor', async () => {
    const { token } = await signUp(ctx.app);
    for (const name of ['A', 'B', 'C']) await createResource(ctx.app, token, { name });

    const first = await ctx.app.inject({ url: '/v1/resources?limit=2', headers: bearer(token) });
    expect(first.json().data.map((r: { name: string }) => r.name)).toEqual(['A', 'B']);
    const { nextCursor } = first.json();
    expect(nextCursor).toEqual(expect.any(String));

    const second = await ctx.app.inject({
      url: `/v1/resources?limit=2&cursor=${nextCursor}`,
      headers: bearer(token),
    });
    expect(second.json()).toMatchObject({ data: [{ name: 'C' }], nextCursor: null });

    const bad = await ctx.app.inject({
      url: '/v1/resources?cursor=garbage',
      headers: bearer(token),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_cursor');
  });

  it('refuses to archive a resource with upcoming bookings', async () => {
    const { token } = await signUp(ctx.app);
    const resource = await createResource(ctx.app, token);
    const day = nextMonday();
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: bearer(token),
      payload: {
        resourceId: resource.id,
        start: at(day, '10:00'),
        end: at(day, '10:30'),
        customer: { name: 'Alex' },
      },
    });

    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/resources/${resource.id}`,
      headers: bearer(token),
    });
    expect(blocked.statusCode).toBe(409);

    const empty = await createResource(ctx.app, token);
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/resources/${empty.id}`,
      headers: bearer(token),
    });
    expect(archived.statusCode).toBe(204);
    const gone = await ctx.app.inject({ url: `/v1/resources/${empty.id}`, headers: bearer(token) });
    expect(gone.statusCode).toBe(404);
  });
});
