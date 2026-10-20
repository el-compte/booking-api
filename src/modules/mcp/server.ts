import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { idSchema } from '../../lib/ids.js';
import { toBooking } from '../bookings/schemas.js';
import {
  type BookingContext,
  cancelBooking,
  createBooking,
  listBookings,
  rescheduleBooking,
} from '../bookings/service.js';
import { toResource } from '../resources/schemas.js';
import { availabilityFor, findResource } from '../resources/service.js';

const INSTRUCTIONS = `
Tools for a booking system. Resources are bookable things (rooms, studios, staff).
Typical flow: list_resources → check_availability for a date → create_booking with a start and
end taken from the free slots. All times are ISO 8601 with a UTC offset, and dates are calendar
days in the resource's own time zone. Bookings must fit the resource's slots and opening hours.
`.trim();

const dateTime = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 with offset, e.g. 2026-11-02T10:00:00+01:00');

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Business-rule errors go back to the assistant as tool errors it can read and act on. */
async function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await action());
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      };
    }
    throw error;
  }
}

/** One MCP server per request, scoped to the caller's account. */
export function createMcpServer(ctx: BookingContext): McpServer {
  const server = new McpServer(
    { name: 'booking-api', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_resources',
    {
      title: 'List resources',
      description: 'Everything that can be booked, with time zone, slot length and opening hours.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const docs = await ctx.collections.resources
          .find({ accountId: ctx.accountId, archivedAt: null })
          .sort({ _id: 1 })
          .limit(100)
          .toArray();
        return { resources: docs.map(toResource) };
      }),
  );

  server.registerTool(
    'check_availability',
    {
      title: 'Check availability',
      description: 'Free slots for a resource on one calendar day (in the resource time zone).',
      inputSchema: {
        resourceId: idSchema,
        date: z.iso.date().describe('Calendar day, YYYY-MM-DD'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ resourceId, date }) =>
      run(async () =>
        availabilityFor(
          ctx.collections,
          await findResource(ctx.collections, ctx.accountId, resourceId),
          date,
        ),
      ),
  );

  server.registerTool(
    'create_booking',
    {
      title: 'Create a booking',
      description:
        'Books a resource. start and end must match free slots; a booking can span several consecutive slots, up to 8 hours.',
      inputSchema: {
        resourceId: idSchema,
        start: dateTime,
        end: dateTime,
        customerName: z.string().trim().min(1).max(100),
        customerEmail: z.email().max(254).optional(),
        customerPhone: z.string().trim().max(30).optional(),
        notes: z.string().trim().max(1000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) =>
      run(async () => {
        const { booking } = await createBooking(ctx, {
          resourceId: input.resourceId,
          start: input.start,
          end: input.end,
          customer: {
            name: input.customerName,
            email: input.customerEmail ?? null,
            phone: input.customerPhone ?? null,
          },
          notes: input.notes ?? null,
        });
        return toBooking(booking);
      }),
  );

  server.registerTool(
    'list_bookings',
    {
      title: 'List bookings',
      description: 'Bookings sorted by start time, optionally filtered.',
      inputSchema: {
        resourceId: idSchema.optional(),
        status: z.enum(['confirmed', 'cancelled']).optional(),
        from: dateTime.optional().describe('Only bookings that end after this time'),
        to: dateTime.optional().describe('Only bookings that start before this time'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    (filters) =>
      run(async () => {
        const page = await listBookings(ctx, filters);
        return { bookings: page.data.map(toBooking), more: page.nextCursor !== null };
      }),
  );

  server.registerTool(
    'reschedule_booking',
    {
      title: 'Reschedule a booking',
      description: 'Moves a confirmed booking to a new start and end on the same resource.',
      inputSchema: { bookingId: idSchema, start: dateTime, end: dateTime },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ bookingId, start, end }) =>
      run(async () => toBooking(await rescheduleBooking(ctx, bookingId, { start, end }))),
  );

  server.registerTool(
    'cancel_booking',
    {
      title: 'Cancel a booking',
      description: 'Cancels a booking and frees its time. Cannot be undone.',
      inputSchema: { bookingId: idSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ bookingId }) => run(async () => toBooking(await cancelBooking(ctx, bookingId))),
  );

  return server;
}
