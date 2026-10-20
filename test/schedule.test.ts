import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { OpeningHours } from '../src/db.js';
import { checkBooking, freeSlots, intervalsOverlap, unitsBetween } from '../src/lib/schedule.js';

const closed = { tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
const schedule = {
  timezone: 'Europe/Paris',
  slotMinutes: 30,
  openingHours: { monday: [{ from: '09:00', to: '12:00' }], ...closed } as OpeningHours,
};
// Monday 2 November 2026, before any of the slots below.
const now = new Date('2026-11-01T12:00:00Z');
const paris = (time: string) =>
  DateTime.fromISO(`2026-11-02T${time}`, { zone: 'Europe/Paris' }).toJSDate();

describe('unitsBetween', () => {
  it('splits a booking into 15-minute units', () => {
    const units = unitsBetween(paris('09:00'), paris('10:00'));
    expect(units.map((u) => u.toISOString())).toEqual([
      '2026-11-02T08:00:00.000Z',
      '2026-11-02T08:15:00.000Z',
      '2026-11-02T08:30:00.000Z',
      '2026-11-02T08:45:00.000Z',
    ]);
  });
});

describe('checkBooking', () => {
  it('accepts a booking on slot boundaries inside opening hours', () => {
    expect(checkBooking(schedule, paris('09:30'), paris('10:30'), now)).toBeNull();
  });

  it.each([
    ['end before start', '10:00', '09:30', 'invalid_time_range'],
    ['outside opening hours', '11:30', '12:30', 'outside_opening_hours'],
    ['off the slot grid', '09:15', '09:45', 'misaligned_slot'],
    ['a length that is not whole slots', '09:00', '09:45', 'misaligned_slot'],
  ])('rejects %s', (_label, start, end, problem) => {
    expect(checkBooking(schedule, paris(start), paris(end), now)).toBe(problem);
  });

  it('rejects bookings in the past', () => {
    expect(checkBooking(schedule, paris('09:00'), paris('09:30'), new Date('2026-11-03'))).toBe(
      'booking_in_past',
    );
  });

  it('rejects days with no opening hours', () => {
    const tuesday = (time: string) =>
      DateTime.fromISO(`2026-11-03T${time}`, { zone: 'Europe/Paris' }).toJSDate();
    expect(checkBooking(schedule, tuesday('09:00'), tuesday('09:30'), now)).toBe(
      'outside_opening_hours',
    );
  });
});

describe('freeSlots', () => {
  it('lists every slot and leaves out booked ones', () => {
    const booked = new Set(unitsBetween(paris('10:00'), paris('11:00')).map((u) => u.getTime()));
    const slots = freeSlots(schedule, '2026-11-02', booked, now).map((s) =>
      s.start.toFormat('HH:mm'),
    );
    expect(slots).toEqual(['09:00', '09:30', '11:00', '11:30']);
  });

  it('skips wall-clock times that do not exist on a daylight-saving day', () => {
    // Clocks in Paris jump from 02:00 to 03:00 on 29 March 2026.
    const night = {
      ...schedule,
      openingHours: { ...schedule.openingHours, sunday: [{ from: '01:00', to: '04:00' }] },
    };
    const slots = freeSlots(night, '2026-03-29', new Set(), new Date('2026-03-28'));
    expect(slots.map((s) => s.start.toFormat('HH:mm'))).toEqual([
      '01:00',
      '01:30',
      '03:00',
      '03:30',
    ]);
  });
});

describe('intervalsOverlap', () => {
  it('detects overlapping opening intervals', () => {
    expect(
      intervalsOverlap([
        { from: '09:00', to: '12:00' },
        { from: '11:00', to: '13:00' },
      ]),
    ).toBe(true);
    expect(
      intervalsOverlap([
        { from: '09:00', to: '12:00' },
        { from: '12:00', to: '13:00' },
      ]),
    ).toBe(false);
  });
});
