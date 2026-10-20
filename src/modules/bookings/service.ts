import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  type BookingDoc,
  type BookingStatus,
  type Collections,
  duplicateKeyIndex,
} from '../../db.js';
import { ApiError, notFound } from '../../errors.js';
import { idSchema, toObjectId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { bookingProblemMessage, checkBooking, unitsBetween } from '../../lib/schedule.js';
import type { WebhookDispatcher } from '../webhooks/dispatcher.js';
import { toBooking } from './schemas.js';

/**
 * Booking rules shared by the REST routes and the MCP tools, so both behave the same.
 * Every function is scoped to one account.
 */
export interface BookingContext {
  collections: Collections;
  webhooks: WebhookDispatcher;
  accountId: ObjectId;
}

export interface NewBooking {
  resourceId: string;
  start: string;
  end: string;
  customer: { name: string; email: string | null; phone: string | null };
  notes: string | null;
}

const slotTaken = () =>
  new ApiError(409, 'slot_unavailable', 'This time overlaps an existing booking');

async function bookableResource(ctx: BookingContext, resourceId: ObjectId) {
  const resource = await ctx.collections.resources.findOne({
    _id: resourceId,
    accountId: ctx.accountId,
    archivedAt: null,
  });
  if (!resource) throw notFound('Resource');
  return resource;
}

function checkTimes(resource: Parameters<typeof checkBooking>[0], start: Date, end: Date) {
  const problem = checkBooking(resource, start, end);
  if (problem) throw new ApiError(422, problem, bookingProblemMessage(problem));
}

/** Same key with the same booking request → replay. Same key with a different one → error. */
function replay(existing: BookingDoc, resourceId: ObjectId, start: Date, end: Date) {
  const sameRequest =
    existing.resourceId.equals(resourceId) &&
    existing.start.getTime() === start.getTime() &&
    existing.end.getTime() === end.getTime();
  if (!sameRequest) {
    throw new ApiError(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different booking',
    );
  }
  return { booking: existing, replayed: true };
}

export async function createBooking(
  ctx: BookingContext,
  input: NewBooking,
  idempotencyKey: string | null = null,
): Promise<{ booking: BookingDoc; replayed: boolean }> {
  const { bookings } = ctx.collections;
  const { accountId } = ctx;
  const resourceId = toObjectId(input.resourceId);
  const start = new Date(input.start);
  const end = new Date(input.end);

  if (idempotencyKey) {
    const existing = await bookings.findOne({ accountId, idempotencyKey });
    if (existing) return replay(existing, resourceId, start, end);
  }

  checkTimes(await bookableResource(ctx, resourceId), start, end);

  const booking: BookingDoc = {
    _id: new ObjectId(),
    accountId,
    resourceId,
    start,
    end,
    units: unitsBetween(start, end),
    status: 'confirmed',
    customer: input.customer,
    notes: input.notes,
    idempotencyKey,
    createdAt: new Date(),
    cancelledAt: null,
    rescheduledAt: null,
  };

  try {
    await bookings.insertOne(booking);
  } catch (error) {
    const index = duplicateKeyIndex(error);
    if (index === 'no_double_booking') throw slotTaken();
    if (index === 'idempotency_key' && idempotencyKey) {
      // A retry with the same key won the race; answer with its booking.
      const existing = await bookings.findOne({ accountId, idempotencyKey });
      if (existing) return replay(existing, resourceId, start, end);
    }
    throw error;
  }

  await ctx.webhooks.emit(accountId, 'booking.created', { booking: toBooking(booking) });
  return { booking, replayed: false };
}

export async function getBooking(ctx: BookingContext, id: string): Promise<BookingDoc> {
  const booking = await ctx.collections.bookings.findOne({
    _id: toObjectId(id),
    accountId: ctx.accountId,
  });
  if (!booking) throw notFound('Booking');
  return booking;
}

export async function cancelBooking(ctx: BookingContext, id: string): Promise<BookingDoc> {
  const booking = await getBooking(ctx, id);
  if (booking.status === 'cancelled') return booking;
  if (booking.start.getTime() <= Date.now()) {
    throw new ApiError(422, 'booking_started', 'Bookings cannot be cancelled once they start');
  }
  const cancelled = await ctx.collections.bookings.findOneAndUpdate(
    { _id: booking._id, status: 'confirmed' },
    { $set: { status: 'cancelled', cancelledAt: new Date() } },
    { returnDocument: 'after' },
  );
  // Null means a concurrent request cancelled it first; return the current state.
  if (!cancelled) return getBooking(ctx, id);
  await ctx.webhooks.emit(ctx.accountId, 'booking.cancelled', { booking: toBooking(cancelled) });
  return cancelled;
}

/**
 * Moves a booking to a new time in one atomic update. The booking may overlap its own
 * old time; the unique index only compares it with other bookings.
 */
export async function rescheduleBooking(
  ctx: BookingContext,
  id: string,
  times: { start: string; end: string },
): Promise<BookingDoc> {
  const booking = await getBooking(ctx, id);
  if (booking.status === 'cancelled') {
    throw new ApiError(422, 'booking_cancelled', 'Cancelled bookings cannot be rescheduled');
  }
  if (booking.start.getTime() <= Date.now()) {
    throw new ApiError(422, 'booking_started', 'Bookings cannot be rescheduled once they start');
  }
  const start = new Date(times.start);
  const end = new Date(times.end);
  if (start.getTime() === booking.start.getTime() && end.getTime() === booking.end.getTime()) {
    return booking;
  }
  checkTimes(await bookableResource(ctx, booking.resourceId), start, end);

  const previous = { start: booking.start.toISOString(), end: booking.end.toISOString() };
  let updated: BookingDoc | null;
  try {
    updated = await ctx.collections.bookings.findOneAndUpdate(
      { _id: booking._id, status: 'confirmed', start: booking.start },
      { $set: { start, end, units: unitsBetween(start, end), rescheduledAt: new Date() } },
      { returnDocument: 'after' },
    );
  } catch (error) {
    if (duplicateKeyIndex(error) === 'no_double_booking') throw slotTaken();
    throw error;
  }
  if (!updated) {
    throw new ApiError(
      409,
      'booking_changed',
      'The booking changed meanwhile. Fetch it and retry.',
    );
  }
  await ctx.webhooks.emit(ctx.accountId, 'booking.rescheduled', {
    booking: toBooking(updated),
    previous,
  });
  return updated;
}

const cursorSchema = z.object({ start: z.number(), id: idSchema });

export interface BookingFilters {
  limit: number;
  cursor?: string | undefined;
  resourceId?: string | undefined;
  status?: BookingStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export async function listBookings(ctx: BookingContext, filters: BookingFilters) {
  const { limit, cursor, resourceId, status, from, to } = filters;
  const after = cursor ? decodeCursor(cursor, cursorSchema) : null;

  const docs = await ctx.collections.bookings
    .find({
      accountId: ctx.accountId,
      ...(resourceId ? { resourceId: toObjectId(resourceId) } : {}),
      ...(status ? { status } : {}),
      ...(from ? { end: { $gt: new Date(from) } } : {}),
      ...(to ? { start: { $lt: new Date(to) } } : {}),
      ...(after
        ? {
            $or: [
              { start: { $gt: new Date(after.start) } },
              { start: new Date(after.start), _id: { $gt: toObjectId(after.id) } },
            ],
          }
        : {}),
    })
    .sort({ start: 1, _id: 1 })
    .limit(limit + 1)
    .toArray();

  const page = docs.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page,
    nextCursor:
      docs.length > limit && last
        ? encodeCursor({ start: last.start.getTime(), id: last._id.toHexString() })
        : null,
  };
}
