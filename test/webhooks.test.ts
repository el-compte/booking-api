import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RETRY_DELAYS_MS } from '../src/modules/webhooks/dispatcher.js';
import { signatureHeader, verifySignature } from '../src/modules/webhooks/signing.js';
import { webhookUrlProblem } from '../src/modules/webhooks/urls.js';
import {
  at,
  bearer,
  createResource,
  createTestApp,
  nextMonday,
  signUp,
  type TestContext,
} from './helpers.js';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A tiny HTTP server standing in for a customer's webhook receiver. */
let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
let respondWith = 200;

let ctx: TestContext;
let token: string;
let resourceId: string;
const day = nextMonday();

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(respondWith).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
  await new Promise((resolve) => receiver.close(resolve));
});
beforeEach(async () => {
  received = [];
  respondWith = 200;
  ({ token } = await signUp(ctx.app));
  ({ id: resourceId } = await createResource(ctx.app, token));
});

const subscribe = (payload: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/webhook-endpoints',
    headers: bearer(token),
    payload,
  });

const book = (start: string, end: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/bookings',
    headers: bearer(token),
    payload: { resourceId, start: at(day, start), end: at(day, end), customer: { name: 'Alex' } },
  });

const deliveriesOf = async (endpointId: string) =>
  (
    await ctx.app.inject({
      url: `/v1/webhook-endpoints/${endpointId}/deliveries`,
      headers: bearer(token),
    })
  ).json().data;

describe('webhook endpoints', () => {
  it('shows the signing secret once', async () => {
    const created = await subscribe({ url: receiverUrl });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      secret: expect.stringMatching(/^whsec_/),
      events: ['booking.created', 'booking.cancelled', 'booking.rescheduled'],
    });
    const list = await ctx.app.inject({ url: '/v1/webhook-endpoints', headers: bearer(token) });
    expect(list.json().data[0]).not.toHaveProperty('secret');
  });

  it("hides other accounts' endpoints", async () => {
    const { id } = (await subscribe({ url: receiverUrl })).json();
    const other = await signUp(ctx.app);
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/webhook-endpoints/${id}`,
      headers: bearer(other.token),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('delivering events', () => {
  it('sends a signed booking.created event', async () => {
    const { id: endpointId, secret } = (await subscribe({ url: receiverUrl })).json();
    const booking = (await book('10:00', '11:00')).json();

    expect(await ctx.app.webhooks.processDue()).toBe(1);
    expect(received).toHaveLength(1);
    const [request] = received;
    if (!request) throw new Error('no webhook received');

    expect(request.headers['webhook-event']).toBe('booking.created');
    expect(request.headers['webhook-id']).toMatch(/^evt_/);
    expect(
      verifySignature(String(request.headers['webhook-signature']), request.body, secret),
    ).toBe(true);
    const event = JSON.parse(request.body);
    expect(event).toMatchObject({ type: 'booking.created', data: { booking: { id: booking.id } } });

    const [delivery] = await deliveriesOf(endpointId);
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200 });
  });

  it('only sends the events an endpoint subscribed to', async () => {
    await subscribe({ url: receiverUrl, events: ['booking.cancelled'] });
    const booking = (await book('10:00', '11:00')).json();
    expect(await ctx.app.webhooks.processDue()).toBe(0);

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/cancel`,
      headers: bearer(token),
    });
    await ctx.app.webhooks.processDue();
    expect(received.map((r) => r.headers['webhook-event'])).toEqual(['booking.cancelled']);
  });

  it('includes the previous time in booking.rescheduled', async () => {
    await subscribe({ url: receiverUrl, events: ['booking.rescheduled'] });
    const booking = (await book('10:00', '11:00')).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/reschedule`,
      headers: bearer(token),
      payload: { start: at(day, '14:00'), end: at(day, '15:00') },
    });
    await ctx.app.webhooks.processDue();
    const event = JSON.parse(received[0]?.body ?? '{}');
    expect(event.type).toBe('booking.rescheduled');
    expect(event.data.previous).toEqual({ start: booking.start, end: booking.end });
  });

  it('retries failed deliveries with backoff', async () => {
    const { id: endpointId } = (await subscribe({ url: receiverUrl })).json();
    respondWith = 500;
    await book('10:00', '11:00');
    const before = Date.now();
    await ctx.app.webhooks.processDue();

    let [delivery] = await deliveriesOf(endpointId);
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 500' });
    const wait = new Date(delivery.nextAttemptAt).getTime() - before;
    expect(wait).toBeGreaterThanOrEqual((RETRY_DELAYS_MS[0] ?? 0) - 1000);

    // Nothing is due until the backoff has passed.
    expect(await ctx.app.webhooks.processDue()).toBe(0);

    // Pretend the 30 seconds have passed and the receiver is back up.
    await ctx.app.collections.webhookDeliveries.updateMany(
      {},
      { $set: { nextAttemptAt: new Date() } },
    );
    respondWith = 204;
    await ctx.app.webhooks.processDue();
    [delivery] = await deliveriesOf(endpointId);
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 2, responseStatus: 204 });
  });
});

describe('signatures', () => {
  const secret = 'whsec_test';
  const body = '{"hello":"world"}';

  it('rejects tampered bodies, wrong secrets and old timestamps', () => {
    const header = signatureHeader(secret, body);
    expect(verifySignature(header, body, secret)).toBe(true);
    expect(verifySignature(header, '{"hello":"there"}', secret)).toBe(false);
    expect(verifySignature(header, body, 'whsec_other')).toBe(false);
    const old = signatureHeader(secret, body, new Date(Date.now() - 10 * 60_000));
    expect(verifySignature(old, body, secret)).toBe(false);
  });
});

describe('webhook URL rules in production', () => {
  it.each([
    ['http://example.com/hook', 'must use https'],
    ['https://localhost/hook', 'must point to a public host'],
    ['https://127.0.0.1/hook', 'must point to a public host'],
    ['https://10.1.2.3/hook', 'must point to a public host'],
    ['https://169.254.169.254/latest/meta-data', 'must point to a public host'],
    ['https://[::1]/hook', 'must point to a public host'],
    ['https://user:pass@example.com/hook', 'must not contain credentials'],
    ['https://example.com/hook', null],
    ['https://93.184.216.34/hook', null],
  ])('%s → %s', (url, problem) => {
    expect(webhookUrlProblem(url, { allowPrivate: false })).toBe(problem);
  });

  it('refuses private URLs when they are not allowed', async () => {
    const strict = await createTestApp({ WEBHOOK_ALLOW_PRIVATE_URLS: 'false' });
    try {
      const { token: strictToken } = await signUp(strict.app);
      const response = await strict.app.inject({
        method: 'POST',
        url: '/v1/webhook-endpoints',
        headers: bearer(strictToken),
        payload: { url: receiverUrl },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_webhook_url');
    } finally {
      await strict.close();
    }
  });
});
