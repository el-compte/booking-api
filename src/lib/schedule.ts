import { DateTime, IANAZone } from 'luxon';
import { type OpeningHours, type OpeningInterval, WEEKDAYS } from '../db.js';

/**
 * Bookings are stored as the 15-minute units they occupy. Every allowed slot length
 * is a multiple of this, so two bookings overlap exactly when they share a unit.
 */
export const UNIT_MINUTES = 15;
export const SLOT_MINUTES = [15, 30, 45, 60, 90, 120] as const;
export const MAX_BOOKING_MINUTES = 8 * 60;

const UNIT_MS = UNIT_MINUTES * 60_000;

export const isValidTimeZone = (zone: string) => IANAZone.isValidZone(zone);

/** "09:30" → 570. Accepts "24:00" as the end of the day. */
export function minutesOfDay(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutes since local midnight as shown on a clock, so daylight-saving days still line up. */
function wallClockMinutes(time: DateTime): number {
  return time.hour * 60 + time.minute + time.second / 60 + time.millisecond / 60_000;
}

export function intervalsOverlap(intervals: OpeningInterval[]): boolean {
  const sorted = intervals
    .map(({ from, to }) => [minutesOfDay(from), minutesOfDay(to)] as const)
    .sort((a, b) => a[0] - b[0]);
  return sorted.some(([from], i) => i > 0 && from < (sorted[i - 1]?.[1] ?? 0));
}

export function unitsBetween(start: Date, end: Date): Date[] {
  const units: Date[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += UNIT_MS) units.push(new Date(t));
  return units;
}

interface Schedule {
  timezone: string;
  slotMinutes: number;
  openingHours: OpeningHours;
}

export type BookingProblem =
  | 'invalid_time_range'
  | 'booking_in_past'
  | 'outside_opening_hours'
  | 'misaligned_slot';

const problemMessages: Record<BookingProblem, string> = {
  invalid_time_range: `end must be after start, and a booking can last at most ${MAX_BOOKING_MINUTES / 60} hours`,
  booking_in_past: 'Bookings must start in the future',
  outside_opening_hours: 'The booking is outside the resource opening hours',
  misaligned_slot: 'start and end must fall on the resource slot boundaries',
};

export function bookingProblemMessage(problem: BookingProblem): string {
  return problemMessages[problem];
}

/** Checks a requested booking against the resource schedule. Returns null if it is allowed. */
export function checkBooking(
  schedule: Schedule,
  start: Date,
  end: Date,
  now = new Date(),
): BookingProblem | null {
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (durationMinutes <= 0 || durationMinutes > MAX_BOOKING_MINUTES) return 'invalid_time_range';
  if (start.getTime() <= now.getTime()) return 'booking_in_past';

  const localStart = DateTime.fromJSDate(start, { zone: schedule.timezone });
  const localEnd = DateTime.fromJSDate(end, { zone: schedule.timezone });
  const startMinute = wallClockMinutes(localStart);
  // An end at midnight belongs to the day the booking started on (24:00).
  const endsAtMidnight = localEnd.equals(localStart.startOf('day').plus({ days: 1 }));
  if (!endsAtMidnight && !localEnd.hasSame(localStart, 'day')) return 'outside_opening_hours';
  const endMinute = endsAtMidnight ? 24 * 60 : wallClockMinutes(localEnd);

  const weekday = WEEKDAYS[localStart.weekday - 1];
  const interval = (weekday ? schedule.openingHours[weekday] : []).find(
    (i) => minutesOfDay(i.from) <= startMinute && endMinute <= minutesOfDay(i.to),
  );
  if (!interval) return 'outside_opening_hours';

  const offset = startMinute - minutesOfDay(interval.from);
  if (
    !Number.isInteger(offset) ||
    offset % schedule.slotMinutes !== 0 ||
    (endMinute - startMinute) % schedule.slotMinutes !== 0
  ) {
    return 'misaligned_slot';
  }
  return null;
}

export interface Slot {
  start: DateTime;
  end: DateTime;
}

/** Day bounds of a local calendar date ("2026-10-21") in the resource time zone. */
export function localDay(isoDate: string, timezone: string): { start: DateTime; end: DateTime } {
  const start = DateTime.fromISO(isoDate, { zone: timezone }).startOf('day');
  return { start, end: start.plus({ days: 1 }) };
}

/**
 * Free slots on a local date: every slot in the opening hours that has not started yet
 * and does not touch a booked unit.
 */
export function freeSlots(
  schedule: Schedule,
  isoDate: string,
  bookedUnits: Set<number>,
  now = new Date(),
): Slot[] {
  const { start: day } = localDay(isoDate, schedule.timezone);
  const weekday = WEEKDAYS[day.weekday - 1];
  const intervals = weekday ? schedule.openingHours[weekday] : [];
  const slots: Slot[] = [];

  for (const interval of intervals) {
    const to = minutesOfDay(interval.to);
    for (
      let m = minutesOfDay(interval.from);
      m + schedule.slotMinutes <= to;
      m += schedule.slotMinutes
    ) {
      const start = day.set({ hour: Math.floor(m / 60), minute: m % 60 });
      // Skip wall-clock times that don't exist because of a daylight-saving jump.
      if (start.hour * 60 + start.minute !== m || !start.hasSame(day, 'day')) continue;
      const end = start.plus({ minutes: schedule.slotMinutes });
      if (start.toMillis() <= now.getTime()) continue;
      const taken = unitsBetween(start.toJSDate(), end.toJSDate()).some((u) =>
        bookedUnits.has(u.getTime()),
      );
      if (!taken) slots.push({ start, end });
    }
  }
  return slots;
}
