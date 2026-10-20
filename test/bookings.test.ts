import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
let token: string;
let resourceId: string;
const day = nextMonday();

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  ({ token } = await signUp(ctx.app));
  ({ id: resourceId } = await createResource(ctx.app, token));
});

function book(start: string, end: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/bookings',
    headers: { ...bearer(token), ...headers },
    payload: {
      resourceId,
      start: at(day, start),
      end: at(day, end),
      customer: { name: 'Alex Martin', email: 'alex@example.com' },
    },
  });
}

describe('creating bookings', () => {
  it('books free slots', async () => {
    const response = await book('10:00', '11:00');
    expect(response.statusCode).toBe(201);
    const booking = response.json();
    expect(response.headers.location).toBe(`/v1/bookings/${booking.id}`);
    expect(booking).toMatchObject({ status: 'confirmed', customer: { name: 'Alex Martin' } });
    expect(new Date(booking.start).toISOString()).toBe(new Date(at(day, '10:00')).toISOString());
  });

  it.each([
    ['the exact same time', '10:00', '11:00'],
    ['an overlap at the start', '09:30', '10:30'],
    ['an overlap at the end', '10:30', '11:30'],
    ['a booking inside it', '10:30', '11:00'],
    ['a booking around it', '09:00', '12:00'],
  ])('rejects %s as a double booking', async (_label, start, end) => {
    expect((await book('10:00', '11:00')).statusCode).toBe(201);
    const response = await book(start, end);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('slot_unavailable');
  });

  it('allows back-to-back bookings', async () => {
    expect((await book('10:00', '11:00')).statusCode).toBe(201);
    expect((await book('11:00', '11:30')).statusCode).toBe(201);
    expect((await book('09:30', '10:00')).statusCode).toBe(201);
  });

  it('lets exactly one of many simultaneous requests win', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => book('14:00', '15:00')));
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
  });

  it.each([
    ['outside opening hours', '16:30', '17:30', 'outside_opening_hours'],
    ['off the slot grid', '10:15', '10:45', 'misaligned_slot'],
    ['end before start', '11:00', '10:00', 'invalid_time_range'],
  ])('rejects a booking %s', async (_label, start, end, code) => {
    const response = await book(start, end);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(code);
  });

  it('rejects bookings in the past and on closed days', async () => {
    const lastWeek = day.minus({ weeks: 2 });
    const past = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: bearer(token),
      payload: {
        resourceId,
        start: at(lastWeek, '10:00'),
        end: at(lastWeek, '10:30'),
        customer: { name: 'A' },
      },
    });
    expect(past.json().error.code).toBe('booking_in_past');

    const sunday = day.plus({ days: 6 });
    const closed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: bearer(token),
      payload: {
        resourceId,
        start: at(sunday, '10:00'),
        end: at(sunday, '10:30'),
        customer: { name: 'A' },
      },
    });
    expect(closed.json().error.code).toBe('outside_opening_hours');
  });

  it("cannot book another account's resource", async () => {
    const other = await signUp(ctx.app);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: bearer(other.token),
      payload: {
        resourceId,
        start: at(day, '10:00'),
        end: at(day, '10:30'),
        customer: { name: 'A' },
      },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('idempotency', () => {
  it('replays the original booking when a request is retried', async () => {
    const headers = { 'idempotency-key': 'order-1234' };
    const first = await book('10:00', '10:30', headers);
    const retry = await book('10:00', '10:30', headers);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json().id).toBe(first.json().id);
  });

  it('rejects the same key for a different booking', async () => {
    const headers = { 'idempotency-key': 'order-5678' };
    await book('10:00', '10:30', headers);
    const reused = await book('11:00', '11:30', headers);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('idempotency_key_reused');
  });
});

describe('cancelling', () => {
  it('frees the slot and is safe to repeat', async () => {
    const booking = (await book('10:00', '11:00')).json();
    const cancel = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/v1/bookings/${booking.id}/cancel`,
        headers: bearer(token),
      });

    const first = await cancel();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) });
    expect((await cancel()).json().status).toBe('cancelled');

    expect((await book('10:00', '11:00')).statusCode).toBe(201);
  });
});

describe('rescheduling', () => {
  const reschedule = (id: string, start: string, end: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/v1/bookings/${id}/reschedule`,
      headers: bearer(token),
      payload: { start: at(day, start), end: at(day, end) },
    });

  it('moves a booking and frees the old time', async () => {
    const booking = (await book('10:00', '11:00')).json();
    const moved = await reschedule(booking.id, '14:00', '15:00');
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: booking.id, rescheduledAt: expect.any(String) });
    expect(new Date(moved.json().start).getTime()).toBe(new Date(at(day, '14:00')).getTime());

    expect((await book('10:00', '11:00')).statusCode).toBe(201);
    expect((await book('14:30', '15:00')).statusCode).toBe(409);
  });

  it('may overlap its own old time', async () => {
    const booking = (await book('10:00', '11:00')).json();
    expect((await reschedule(booking.id, '10:30', '11:30')).statusCode).toBe(200);
  });

  it('refuses a time taken by another booking', async () => {
    const booking = (await book('10:00', '11:00')).json();
    await book('12:00', '13:00');
    const response = await reschedule(booking.id, '11:30', '12:30');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('slot_unavailable');
    // The original time is untouched.
    const fetched = await ctx.app.inject({
      url: `/v1/bookings/${booking.id}`,
      headers: bearer(token),
    });
    expect(fetched.json().start).toBe(booking.start);
  });

  it('lets only one of two bookings move into the same free time', async () => {
    const first = (await book('09:00', '09:30')).json();
    const second = (await book('09:30', '10:00')).json();
    const codes = (
      await Promise.all([
        reschedule(first.id, '15:00', '16:00'),
        reschedule(second.id, '15:30', '16:30'),
      ])
    ).map((r) => r.statusCode);
    expect(codes.sort()).toEqual([200, 409]);
  });

  it('checks opening hours and refuses cancelled bookings', async () => {
    const booking = (await book('10:00', '11:00')).json();
    const late = await reschedule(booking.id, '16:30', '17:30');
    expect(late.json().error.code).toBe('outside_opening_hours');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/cancel`,
      headers: bearer(token),
    });
    const cancelled = await reschedule(booking.id, '14:00', '15:00');
    expect(cancelled.statusCode).toBe(422);
    expect(cancelled.json().error.code).toBe('booking_cancelled');
  });
});

describe('listing', () => {
  it('filters and pages through bookings in start order', async () => {
    for (const start of ['13:00', '09:00', '11:00']) {
      const [h = 0, m = 0] = start.split(':').map(Number);
      await book(start, `${String(h).padStart(2, '0')}:${String(m + 30).padStart(2, '0')}`);
    }
    const list = (query: string) =>
      ctx.app.inject({
        url: `/v1/bookings?resourceId=${resourceId}&${query}`,
        headers: bearer(token),
      });

    const first = (await list('limit=2')).json();
    expect(first.data.map((b: { start: string }) => new Date(b.start).getTime())).toEqual([
      new Date(at(day, '09:00')).getTime(),
      new Date(at(day, '11:00')).getTime(),
    ]);
    const second = (await list(`limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const afternoon = (await list(`from=${encodeURIComponent(at(day, '12:00'))}`)).json();
    expect(afternoon.data).toHaveLength(1);
  });
});

describe('availability', () => {
  it('lists free slots without the booked ones', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/resources/${resourceId}`,
      headers: bearer(token),
      payload: { openingHours: { monday: [{ from: '09:00', to: '11:00' }] } },
    });
    await book('09:30', '10:30');

    const response = await ctx.app.inject({
      url: `/v1/resources/${resourceId}/availability?date=${day.toISODate()}`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ timezone: 'Europe/Paris', slotMinutes: 30 });
    expect(body.slots.map((s: { start: string }) => s.start.slice(11, 16))).toEqual([
      '09:00',
      '10:30',
    ]);
  });
});
