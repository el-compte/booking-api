import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Deliveries carry a `Webhook-Signature: t=<unix seconds>,v1=<hex>` header, where v1 is
 * HMAC-SHA256(secret, `${t}.${body}`). Receivers recompute it to prove the request came
 * from this API, and reject old timestamps to stop replays.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secret: string, body: string, now = new Date()): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export function verifySignature(
  header: string,
  body: string,
  secret: string,
  { toleranceSeconds = 300, now = new Date() } = {},
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((part) => part.split('=', 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
