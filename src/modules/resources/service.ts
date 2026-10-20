import { DateTime } from 'luxon';
import type { ObjectId } from 'mongodb';
import type { Collections, ResourceDoc } from '../../db.js';
import { ApiError, notFound } from '../../errors.js';
import { toObjectId } from '../../lib/ids.js';
import { freeSlots, localDay } from '../../lib/schedule.js';

const MAX_DAYS_AHEAD = 366;

export async function findResource(
  collections: Collections,
  accountId: ObjectId,
  id: string,
): Promise<ResourceDoc> {
  const resource = await collections.resources.findOne({
    _id: toObjectId(id),
    accountId,
    archivedAt: null,
  });
  if (!resource) throw notFound('Resource');
  return resource;
}

export interface Availability {
  resourceId: string;
  date: string;
  timezone: string;
  slotMinutes: number;
  slots: { start: string; end: string }[];
}

/** Free slots on a calendar day (YYYY-MM-DD) in the resource's own time zone. */
export async function availabilityFor(
  collections: Collections,
  resource: ResourceDoc,
  date: string,
): Promise<Availability> {
  const day = localDay(date, resource.timezone);
  if (!day.start.isValid) throw new ApiError(400, 'invalid_date', 'date is not a valid day');
  const today = DateTime.now().setZone(resource.timezone).startOf('day');
  if (day.start.diff(today, 'days').days > MAX_DAYS_AHEAD) {
    throw new ApiError(400, 'date_out_of_range', `date must be within ${MAX_DAYS_AHEAD} days`);
  }

  const booked = await collections.bookings
    .find(
      {
        resourceId: resource._id,
        status: 'confirmed',
        start: { $lt: day.end.toJSDate() },
        end: { $gt: day.start.toJSDate() },
      },
      { projection: { units: 1 } },
    )
    .toArray();
  const bookedUnits = new Set(booked.flatMap((b) => b.units.map((u) => u.getTime())));

  return {
    resourceId: resource._id.toHexString(),
    date,
    timezone: resource.timezone,
    slotMinutes: resource.slotMinutes,
    slots: freeSlots(resource, date, bookedUnits).map(({ start, end }) => ({
      start: start.toISO({ suppressMilliseconds: true }) ?? '',
      end: end.toISO({ suppressMilliseconds: true }) ?? '',
    })),
  };
}
