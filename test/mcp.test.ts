import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
let baseUrl: string;
let client: Client;
let resourceId: string;
const day = nextMonday();

beforeAll(async () => {
  ctx = await createTestApp();
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;

  const { token } = await signUp(ctx.app);
  ({ id: resourceId } = await createResource(ctx.app, token, { name: 'Studio A' }));
  const { key } = (
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: bearer(token),
      payload: { name: 'Claude' },
    })
  ).json();

  client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { 'x-api-key': key } },
    }),
  );
});
afterAll(async () => {
  await client.close();
  await ctx.close();
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: first?.text ?? '' };
}
const json = async (name: string, args?: Record<string, unknown>) =>
  JSON.parse((await callTool(name, args)).text);

describe('MCP server', () => {
  it('lists the booking tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_booking',
      'check_availability',
      'create_booking',
      'list_bookings',
      'list_resources',
      'reschedule_booking',
    ]);
    expect(tools.find((t) => t.name === 'cancel_booking')?.annotations?.destructiveHint).toBe(true);
  });

  it('finds a resource, books a free slot, then sees it taken', async () => {
    const { resources } = await json('list_resources');
    expect(resources.map((r: { id: string }) => r.id)).toContain(resourceId);

    const date = day.toISODate();
    const before = await json('check_availability', { resourceId, date });
    const slot = before.slots.find((s: { start: string }) => s.start.includes('T10:00'));
    expect(slot).toBeDefined();

    const booking = await json('create_booking', {
      resourceId,
      start: slot.start,
      end: slot.end,
      customerName: 'Booked by an assistant',
    });
    expect(booking).toMatchObject({
      status: 'confirmed',
      customer: { name: 'Booked by an assistant' },
    });

    const after = await json('check_availability', { resourceId, date });
    expect(after.slots.map((s: { start: string }) => s.start)).not.toContain(slot.start);

    const { bookings } = await json('list_bookings', { resourceId });
    expect(bookings.map((b: { id: string }) => b.id)).toContain(booking.id);
  });

  it('reports booking rules as tool errors the assistant can read', async () => {
    const taken = await callTool('create_booking', {
      resourceId,
      start: at(day, '10:00'),
      end: at(day, '10:30'),
      customerName: 'Second try',
    });
    expect(taken).toMatchObject({
      isError: true,
      text: expect.stringContaining('slot_unavailable'),
    });

    const closed = await callTool('create_booking', {
      resourceId,
      start: at(day, '20:00'),
      end: at(day, '20:30'),
      customerName: 'Night owl',
    });
    expect(closed.text).toContain('outside_opening_hours');
  });

  it('reschedules and cancels', async () => {
    const booking = await json('create_booking', {
      resourceId,
      start: at(day, '13:00'),
      end: at(day, '14:00'),
      customerName: 'Moving soon',
    });
    const moved = await json('reschedule_booking', {
      bookingId: booking.id,
      start: at(day, '15:00'),
      end: at(day, '16:00'),
    });
    expect(moved.rescheduledAt).not.toBeNull();

    const cancelled = await json('cancel_booking', { bookingId: booking.id });
    expect(cancelled.status).toBe('cancelled');
  });

  it('requires the same credentials as the REST API', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });
});
