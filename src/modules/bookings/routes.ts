import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { type BookingDoc, duplicateKeyIndex } from '../../db.js';
import { ApiError, errorResponses, notFound } from '../../errors.js';
import { idParams, idSchema, toObjectId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor, pageSchema, paginationQuery } from '../../lib/pagination.js';
import { bookingProblemMessage, checkBooking, unitsBetween } from '../../lib/schedule.js';
import { anyAuth, authOf } from '../../plugins/auth.js';

const dateTime = z.iso.datetime({ offset: true });

const bookingSchema = z
  .object({
    id: z.string(),
    resourceId: z.string(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    status: z.enum(['confirmed', 'cancelled']),
    customer: z.object({
      name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
    }),
    notes: z.string().nullable(),
    createdAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Booking' });

const createBookingBody = z.object({
  resourceId: idSchema,
  start: dateTime.meta({ example: '2026-11-02T10:00:00+01:00' }),
  end: dateTime.meta({ example: '2026-11-02T11:00:00+01:00' }),
  customer: z.object({
    name: z.string().trim().min(1).max(100).meta({ example: 'Alex Martin' }),
    email: z.email().max(254).nullable().default(null),
    phone: z.string().trim().max(30).nullable().default(null),
  }),
  notes: z.string().trim().max(1000).nullable().default(null),
});

const idempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Send the same key when retrying, so a booking is never created twice'),
});

const listBookingsQuery = paginationQuery.extend({
  resourceId: idSchema.optional(),
  status: z.enum(['confirmed', 'cancelled']).optional(),
  from: dateTime.optional().describe('Only bookings that end after this time'),
  to: dateTime.optional().describe('Only bookings that start before this time'),
});

const cursorSchema = z.object({ start: z.number(), id: idSchema });

const toBooking = (doc: BookingDoc): z.infer<typeof bookingSchema> => ({
  id: doc._id.toHexString(),
  resourceId: doc.resourceId.toHexString(),
  start: doc.start.toISOString(),
  end: doc.end.toISOString(),
  status: doc.status,
  customer: doc.customer,
  notes: doc.notes,
  createdAt: doc.createdAt.toISOString(),
  cancelledAt: doc.cancelledAt?.toISOString() ?? null,
});

export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { bookings, resources } = app.collections;
  app.addHook('onRequest', app.authenticate);

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
    return existing;
  }

  app.post(
    '/bookings',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Book a resource',
        description:
          'Times must match the resource slots and opening hours. Overlapping bookings are rejected with `409 slot_unavailable`, even when two requests arrive at the same moment.',
        security: anyAuth,
        headers: idempotencyHeaders,
        body: createBookingBody,
        response: {
          200: bookingSchema.describe(
            'Replayed: a booking with this Idempotency-Key already exists',
          ),
          201: bookingSchema,
          ...errorResponses(400, 401, 404, 409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const { accountId } = authOf(request);
      const header = request.headers['idempotency-key'];
      const idempotencyKey = typeof header === 'string' ? header : null;
      const { resourceId: rawResourceId, customer, notes } = request.body;
      const resourceId = toObjectId(rawResourceId);
      const start = new Date(request.body.start);
      const end = new Date(request.body.end);

      if (idempotencyKey) {
        const existing = await bookings.findOne({ accountId, idempotencyKey });
        if (existing) {
          return reply
            .status(200)
            .header('idempotent-replayed', 'true')
            .send(toBooking(replay(existing, resourceId, start, end)));
        }
      }

      const resource = await resources.findOne({ _id: resourceId, accountId, archivedAt: null });
      if (!resource) throw notFound('Resource');

      const problem = checkBooking(resource, start, end);
      if (problem) throw new ApiError(422, problem, bookingProblemMessage(problem));

      const booking: BookingDoc = {
        _id: new ObjectId(),
        accountId,
        resourceId,
        start,
        end,
        units: unitsBetween(start, end),
        status: 'confirmed',
        customer,
        notes,
        idempotencyKey,
        createdAt: new Date(),
        cancelledAt: null,
      };

      try {
        await bookings.insertOne(booking);
      } catch (error) {
        const index = duplicateKeyIndex(error);
        if (index === 'no_double_booking') {
          throw new ApiError(409, 'slot_unavailable', 'This time overlaps an existing booking');
        }
        if (index === 'idempotency_key' && idempotencyKey) {
          // A retry with the same key won the race; answer with its booking.
          const existing = await bookings.findOne({ accountId, idempotencyKey });
          if (existing) {
            return reply
              .status(200)
              .header('idempotent-replayed', 'true')
              .send(toBooking(replay(existing, resourceId, start, end)));
          }
        }
        throw error;
      }

      return reply
        .status(201)
        .header('location', `/v1/bookings/${booking._id.toHexString()}`)
        .send(toBooking(booking));
    },
  );

  app.get(
    '/bookings',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'List bookings',
        description: 'Sorted by start time, oldest first.',
        security: anyAuth,
        querystring: listBookingsQuery,
        response: { 200: pageSchema(bookingSchema), ...errorResponses(400, 401, 429) },
      },
    },
    async (request) => {
      const { limit, cursor, resourceId, status, from, to } = request.query;
      const after = cursor ? decodeCursor(cursor, cursorSchema) : null;

      const docs = await bookings
        .find({
          accountId: authOf(request).accountId,
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
        data: page.map(toBooking),
        nextCursor:
          docs.length > limit && last
            ? encodeCursor({ start: last.start.getTime(), id: last._id.toHexString() })
            : null,
      };
    },
  );

  app.get(
    '/bookings/:id',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Get a booking',
        security: anyAuth,
        params: idParams,
        response: { 200: bookingSchema, ...errorResponses(400, 401, 404, 429) },
      },
    },
    async (request) => {
      const booking = await bookings.findOne({
        _id: toObjectId(request.params.id),
        accountId: authOf(request).accountId,
      });
      if (!booking) throw notFound('Booking');
      return toBooking(booking);
    },
  );

  app.post(
    '/bookings/:id/cancel',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Cancel a booking',
        description: 'Frees the slots straight away. Cancelling twice is safe.',
        security: anyAuth,
        params: idParams,
        response: { 200: bookingSchema, ...errorResponses(400, 401, 404, 422, 429) },
      },
    },
    async (request) => {
      const filter = { _id: toObjectId(request.params.id), accountId: authOf(request).accountId };
      const booking = await bookings.findOne(filter);
      if (!booking) throw notFound('Booking');
      if (booking.status === 'cancelled') return toBooking(booking);
      if (booking.start.getTime() <= Date.now()) {
        throw new ApiError(422, 'booking_started', 'Bookings cannot be cancelled once they start');
      }
      const cancelled = await bookings.findOneAndUpdate(
        { ...filter, status: 'confirmed' },
        { $set: { status: 'cancelled', cancelledAt: new Date() } },
        { returnDocument: 'after' },
      );
      // Null means a concurrent request cancelled it first; return the current state.
      return toBooking(cancelled ?? (await bookings.findOne(filter)) ?? booking);
    },
  );
};
