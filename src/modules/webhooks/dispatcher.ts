import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import type { Collections, WebhookDeliveryDoc, WebhookEvent } from '../../db.js';
import { signatureHeader } from './signing.js';
import { webhookUrlProblem } from './urls.js';

/** Wait before each retry: 30s, 2m, 10m, 1h, 6h. After that the delivery is marked failed. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const LOCK_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface WebhookDispatcher {
  /** Records one delivery per subscribed endpoint. Sending happens in the background. */
  emit(accountId: ObjectId, type: WebhookEvent, data: Record<string, unknown>): Promise<void>;
  /** Sends every delivery that is due. Returns how many were attempted. */
  processDue(limit?: number): Promise<number>;
  start(intervalMs: number): void;
  stop(): void;
}

interface Options {
  collections: Collections;
  log: FastifyBaseLogger;
  allowPrivateUrls: boolean;
  fetch?: typeof fetch;
}

export function createWebhookDispatcher({
  collections,
  log,
  allowPrivateUrls,
  fetch: fetchImpl = fetch,
}: Options): WebhookDispatcher {
  const { webhookEndpoints, webhookDeliveries } = collections;
  let timer: NodeJS.Timeout | null = null;

  async function emit(accountId: ObjectId, type: WebhookEvent, data: Record<string, unknown>) {
    const endpoints = await webhookEndpoints.find({ accountId, events: type }).toArray();
    if (endpoints.length === 0) return;
    const now = new Date();
    const eventId = `evt_${randomBytes(12).toString('hex')}`;
    const payload = { id: eventId, type, createdAt: now.toISOString(), data };
    await webhookDeliveries.insertMany(
      endpoints.map(
        (endpoint): WebhookDeliveryDoc => ({
          _id: new ObjectId(),
          accountId,
          endpointId: endpoint._id,
          eventId,
          type,
          payload,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          lockedUntil: null,
          lastError: null,
          responseStatus: null,
          createdAt: now,
          deliveredAt: null,
        }),
      ),
    );
    // When the worker is running, send right away instead of waiting for the next tick.
    if (timer) setImmediate(() => void processDue().catch((err) => log.error({ err }, 'webhooks')));
  }

  /** Claims one due delivery so that two workers never send the same one at once. */
  function claim(now: Date) {
    return webhookDeliveries.findOneAndUpdate(
      {
        status: 'pending',
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
  }

  async function send(
    delivery: WebhookDeliveryDoc,
  ): Promise<{ status: number | null; error: string | null }> {
    const endpoint = await webhookEndpoints.findOne({ _id: delivery.endpointId });
    if (!endpoint) return { status: null, error: 'endpoint was deleted' };
    const problem = webhookUrlProblem(endpoint.url, { allowPrivate: allowPrivateUrls });
    if (problem) return { status: null, error: `url ${problem}` };

    const body = JSON.stringify(delivery.payload);
    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'BookingAPI-Webhooks/1.0',
          'webhook-id': delivery.eventId,
          'webhook-event': delivery.type,
          'webhook-signature': signatureHeader(endpoint.secret, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.ok
        ? { status: response.status, error: null }
        : { status: response.status, error: `HTTP ${response.status}` };
    } catch (err) {
      return { status: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function processDue(limit = 25): Promise<number> {
    let attempted = 0;
    for (; attempted < limit; attempted++) {
      const now = new Date();
      const delivery = await claim(now);
      if (!delivery) break;

      const { status, error } = await send(delivery);
      const attempts = delivery.attempts + 1;
      const giveUp =
        error !== null && (attempts >= MAX_ATTEMPTS || error === 'endpoint was deleted');
      const retryDelay = RETRY_DELAYS_MS[attempts - 1] ?? 0;

      await webhookDeliveries.updateOne(
        { _id: delivery._id },
        {
          $set: {
            attempts,
            responseStatus: status,
            lastError: error,
            lockedUntil: null,
            ...(error === null
              ? { status: 'delivered', deliveredAt: new Date(), nextAttemptAt: null }
              : giveUp
                ? { status: 'failed', nextAttemptAt: null }
                : { nextAttemptAt: new Date(Date.now() + retryDelay) }),
          },
        },
      );
      if (error) log.warn({ deliveryId: delivery._id, attempts, error }, 'webhook delivery failed');
    }
    return attempted;
  }

  return {
    emit,
    processDue,
    start(intervalMs) {
      if (timer) return;
      timer = setInterval(() => {
        processDue().catch((err) => log.error({ err }, 'webhook worker failed'));
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
