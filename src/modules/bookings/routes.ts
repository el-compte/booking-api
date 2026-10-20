import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../errors.js';
import { idParams } from '../../lib/ids.js';
import { pageSchema } from '../../lib/pagination.js';
import { anyAuth, authOf } from '../../plugins/auth.js';
import {
  bookingSchema,
  createBookingBody,
  listBookingsQuery,
  rescheduleBody,
  toBooking,
} from './schemas.js';
import {
  type BookingContext,
  cancelBooking,
  createBooking,
  getBooking,
  listBookings,
  rescheduleBooking,
} from './service.js';

const idempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Send the same key when retrying, so a booking is never created twice'),
});

export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const contextOf = (request: FastifyRequest): BookingContext => ({
    collections: app.collections,
    webhooks: app.webhooks,
    accountId: authOf(request).accountId,
  });

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
      const header = request.headers['idempotency-key'];
      const { booking, replayed } = await createBooking(
        contextOf(request),
        request.body,
        typeof header === 'string' ? header : null,
      );
      if (replayed) {
        return reply.status(200).header('idempotent-replayed', 'true').send(toBooking(booking));
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
      const page = await listBookings(contextOf(request), request.query);
      return { data: page.data.map(toBooking), nextCursor: page.nextCursor };
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
    async (request) => toBooking(await getBooking(contextOf(request), request.params.id)),
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
    async (request) => toBooking(await cancelBooking(contextOf(request), request.params.id)),
  );

  app.post(
    '/bookings/:id/reschedule',
    {
      schema: {
        tags: ['Bookings'],
        summary: 'Move a booking to a new time',
        description:
          'One atomic change: the new time is checked against opening hours and other bookings, and the old slots are freed in the same step. The new time may overlap the old one.',
        security: anyAuth,
        params: idParams,
        body: rescheduleBody,
        response: { 200: bookingSchema, ...errorResponses(400, 401, 404, 409, 422, 429) },
      },
    },
    async (request) =>
      toBooking(await rescheduleBooking(contextOf(request), request.params.id, request.body)),
  );
};
