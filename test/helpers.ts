import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { DateTime } from 'luxon';
import { type Db, MongoClient } from 'mongodb';
import { inject } from 'vitest';
import { type App, buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureIndexes, getCollections } from '../src/db.js';

export const TIMEZONE = 'Europe/Paris';

export interface TestContext {
  app: App;
  db: Db;
  close: () => Promise<void>;
}

/** A fresh app with its own database, so test files never see each other's data. */
export async function createTestApp(
  env: Record<string, string> = {},
  { redis }: { redis?: Redis } = {},
): Promise<TestContext> {
  const client = new MongoClient(inject('mongoUri'));
  await client.connect();
  const db = client.db(`test_${randomUUID().slice(0, 8)}`);
  await ensureIndexes(getCollections(db));

  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
    BCRYPT_ROUNDS: '4',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '1000',
    AUTH_RATE_LIMIT_MAX: '1000',
    ...env,
  });
  const app = await buildApp({ config, db, redis: redis ?? null });
  await app.ready();

  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.dropDatabase();
      await client.close();
    },
  };
}

let userCount = 0;

export async function signUp(app: App) {
  userCount += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      email: `user${userCount}-${randomUUID().slice(0, 6)}@example.com`,
      password: 'correct-horse-battery',
      name: `User ${userCount}`,
    },
  });
  const body = response.json();
  return { token: body.accessToken as string, accountId: body.account.id as string };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function createResource(app: App, token: string, payload: object = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/resources',
    headers: bearer(token),
    payload: { name: 'Room A', timezone: TIMEZONE, slotMinutes: 30, ...payload },
  });
  return response.json() as { id: string; slotMinutes: number };
}

/** A Monday at least a week ahead, as a local date in the test time zone. */
export function nextMonday(): DateTime {
  const today = DateTime.now().setZone(TIMEZONE).startOf('day');
  return today.plus({ days: 7 + ((8 - today.weekday) % 7) });
}

/** ISO timestamp for a local wall-clock time on `day`, e.g. at(day, '10:30'). */
export function at(day: DateTime, time: string): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return day.set({ hour, minute }).toISO() ?? '';
}
