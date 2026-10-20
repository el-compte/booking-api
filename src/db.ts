import { type Collection, type Db, MongoClient, MongoServerError, type ObjectId } from 'mongodb';

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Local wall-clock times in the resource's time zone, "HH:MM" (24:00 allowed as an end). */
export interface OpeningInterval {
  from: string;
  to: string;
}
export type OpeningHours = Record<Weekday, OpeningInterval[]>;

export interface AccountDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}

export interface ApiKeyDoc {
  _id: ObjectId;
  accountId: ObjectId;
  name: string;
  /** First characters of the key, safe to show so users can tell keys apart. */
  prefix: string;
  /** SHA-256 of the full key. The key itself is never stored. */
  hash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type MetadataValue = string | number | boolean | string[];

export interface ResourceDoc {
  _id: ObjectId;
  accountId: ObjectId;
  name: string;
  description: string | null;
  timezone: string;
  slotMinutes: number;
  openingHours: OpeningHours;
  /** Free-form data owned by the client (photos, price, address...). Stored as-is. */
  metadata: Record<string, MetadataValue>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export type BookingStatus = 'confirmed' | 'cancelled';

export interface BookingDoc {
  _id: ObjectId;
  accountId: ObjectId;
  resourceId: ObjectId;
  start: Date;
  end: Date;
  /**
   * Start of every 15-minute unit the booking occupies. A unique index on
   * (resourceId, units) for confirmed bookings makes double booking impossible,
   * even under concurrent requests.
   */
  units: Date[];
  status: BookingStatus;
  customer: { name: string; email: string | null; phone: string | null };
  notes: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  rescheduledAt?: Date | null;
}

export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.cancelled',
  'booking.rescheduled',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEndpointDoc {
  _id: ObjectId;
  accountId: ObjectId;
  url: string;
  events: WebhookEvent[];
  /** Shared secret used to sign deliveries (HMAC-SHA256). */
  secret: string;
  createdAt: Date;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

/**
 * One event to send to one endpoint. Deliveries are written to the database first
 * (an outbox) and sent by a background worker, which retries failures with backoff.
 */
export interface WebhookDeliveryDoc {
  _id: ObjectId;
  accountId: ObjectId;
  endpointId: ObjectId;
  eventId: string;
  type: WebhookEvent;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lockedUntil: Date | null;
  lastError: string | null;
  responseStatus: number | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface Collections {
  accounts: Collection<AccountDoc>;
  apiKeys: Collection<ApiKeyDoc>;
  resources: Collection<ResourceDoc>;
  bookings: Collection<BookingDoc>;
  webhookEndpoints: Collection<WebhookEndpointDoc>;
  webhookDeliveries: Collection<WebhookDeliveryDoc>;
}

export function getCollections(db: Db): Collections {
  return {
    accounts: db.collection<AccountDoc>('accounts'),
    apiKeys: db.collection<ApiKeyDoc>('apiKeys'),
    resources: db.collection<ResourceDoc>('resources'),
    bookings: db.collection<BookingDoc>('bookings'),
    webhookEndpoints: db.collection<WebhookEndpointDoc>('webhookEndpoints'),
    webhookDeliveries: db.collection<WebhookDeliveryDoc>('webhookDeliveries'),
  };
}

export async function ensureIndexes(collections: Collections): Promise<void> {
  await Promise.all([
    collections.accounts.createIndex({ email: 1 }, { unique: true }),
    collections.apiKeys.createIndex({ hash: 1 }, { unique: true }),
    collections.apiKeys.createIndex({ accountId: 1, createdAt: -1 }),
    collections.resources.createIndex({ accountId: 1, _id: 1 }),
    collections.bookings.createIndex(
      { resourceId: 1, units: 1 },
      {
        name: 'no_double_booking',
        unique: true,
        partialFilterExpression: { status: 'confirmed' },
      },
    ),
    collections.bookings.createIndex(
      { accountId: 1, idempotencyKey: 1 },
      {
        name: 'idempotency_key',
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
    ),
    collections.bookings.createIndex({ accountId: 1, start: 1, _id: 1 }),
    collections.bookings.createIndex({ resourceId: 1, status: 1, start: 1 }),
    collections.webhookEndpoints.createIndex({ accountId: 1, createdAt: -1 }),
    collections.webhookDeliveries.createIndex({ status: 1, nextAttemptAt: 1 }),
    collections.webhookDeliveries.createIndex({ endpointId: 1, createdAt: -1 }),
    // Keep delivery history for 30 days.
    collections.webhookDeliveries.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 30 * 24 * 60 * 60 },
    ),
  ]);
}

export async function connectDb(uri: string): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}

/** Name of the index that caused a duplicate-key error, if that is what `error` is. */
export function duplicateKeyIndex(error: unknown): string | null {
  if (error instanceof MongoServerError && error.code === 11000) {
    const match = /index: (\S+)/.exec(error.message);
    return match?.[1] ?? 'unknown';
  }
  return null;
}
