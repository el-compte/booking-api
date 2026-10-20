import { z } from 'zod';
import type { BookingDoc } from '../../db.js';
import { idSchema } from '../../lib/ids.js';
import { paginationQuery } from '../../lib/pagination.js';

export const dateTime = z.iso.datetime({ offset: true });

export const bookingSchema = z
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
    rescheduledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Booking' });

export type BookingJson = z.infer<typeof bookingSchema>;

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(100).meta({ example: 'Alex Martin' }),
  email: z.email().max(254).nullable().default(null),
  phone: z.string().trim().max(30).nullable().default(null),
});

export const createBookingBody = z.object({
  resourceId: idSchema,
  start: dateTime.meta({ example: '2026-11-02T10:00:00+01:00' }),
  end: dateTime.meta({ example: '2026-11-02T11:00:00+01:00' }),
  customer: customerSchema,
  notes: z.string().trim().max(1000).nullable().default(null),
});

export const rescheduleBody = z.object({
  start: dateTime.meta({ example: '2026-11-02T14:00:00+01:00' }),
  end: dateTime.meta({ example: '2026-11-02T15:00:00+01:00' }),
});

export const listBookingsQuery = paginationQuery.extend({
  resourceId: idSchema.optional(),
  status: z.enum(['confirmed', 'cancelled']).optional(),
  from: dateTime.optional().describe('Only bookings that end after this time'),
  to: dateTime.optional().describe('Only bookings that start before this time'),
});

export const toBooking = (doc: BookingDoc): BookingJson => ({
  id: doc._id.toHexString(),
  resourceId: doc.resourceId.toHexString(),
  start: doc.start.toISOString(),
  end: doc.end.toISOString(),
  status: doc.status,
  customer: doc.customer,
  notes: doc.notes,
  createdAt: doc.createdAt.toISOString(),
  cancelledAt: doc.cancelledAt?.toISOString() ?? null,
  rescheduledAt: doc.rescheduledAt?.toISOString() ?? null,
});
