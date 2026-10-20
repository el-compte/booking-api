import { z } from 'zod';
import { type OpeningHours, type ResourceDoc, WEEKDAYS } from '../../db.js';
import {
  intervalsOverlap,
  isValidTimeZone,
  minutesOfDay,
  SLOT_MINUTES,
} from '../../lib/schedule.js';

const clockTime = z
  .string()
  .regex(/^(([01]\d|2[0-3]):(00|15|30|45)|24:00)$/, 'must be HH:MM on a quarter hour, e.g. 09:30');

const intervalSchema = z
  .object({ from: clockTime, to: clockTime })
  .refine((i) => minutesOfDay(i.from) < minutesOfDay(i.to), 'from must be before to');

const dayHours = z
  .array(intervalSchema)
  .max(6)
  .refine((intervals) => !intervalsOverlap(intervals), 'intervals must not overlap');

export const DEFAULT_OPENING_HOURS: OpeningHours = {
  monday: [{ from: '09:00', to: '17:00' }],
  tuesday: [{ from: '09:00', to: '17:00' }],
  wednesday: [{ from: '09:00', to: '17:00' }],
  thursday: [{ from: '09:00', to: '17:00' }],
  friday: [{ from: '09:00', to: '17:00' }],
  saturday: [],
  sunday: [],
};

export const openingHoursSchema = z
  .object(
    Object.fromEntries(WEEKDAYS.map((day) => [day, dayHours.default([])])) as {
      [K in (typeof WEEKDAYS)[number]]: z.ZodDefault<typeof dayHours>;
    },
  )
  .describe('Local times in the resource time zone. Days left out are closed.')
  .meta({
    id: 'OpeningHours',
    example: {
      monday: [
        { from: '09:00', to: '12:00' },
        { from: '13:00', to: '18:00' },
      ],
      saturday: [{ from: '10:00', to: '14:00' }],
    },
  });

const MAX_METADATA_KEYS = 30;

export const metadataSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][\w-]{0,39}$/, 'keys must be letters, digits, - or _ (max 40)'),
    z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(2000)).max(20)]),
  )
  .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, `at most ${MAX_METADATA_KEYS} keys`)
  .describe(
    'Your own data, such as photos, a price or an address. Stored and returned as-is. Updating it replaces the whole object.',
  )
  .meta({
    id: 'Metadata',
    example: { city: 'Lyon', pricePerHour: 45, images: ['https://example.com/studio.jpg'] },
  });

const timezone = z
  .string()
  .refine(isValidTimeZone, 'must be an IANA time zone, e.g. Europe/Paris')
  .meta({ example: 'Europe/Paris' });

export const createResourceBody = z.object({
  name: z.string().trim().min(1).max(100).meta({ example: 'Chair 1' }),
  description: z.string().trim().max(500).nullable().default(null),
  timezone,
  slotMinutes: z
    .literal(SLOT_MINUTES)
    .default(30)
    .describe('Length of one bookable slot. Bookings can span several slots.'),
  openingHours: openingHoursSchema.default(DEFAULT_OPENING_HOURS),
  metadata: metadataSchema.default({}),
});

export const updateResourceBody = z
  .object({
    name: createResourceBody.shape.name,
    description: z.string().trim().max(500).nullable(),
    timezone,
    slotMinutes: z.literal(SLOT_MINUTES),
    openingHours: openingHoursSchema,
    metadata: metadataSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'send at least one field to update');

export const resourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    timezone: z.string(),
    slotMinutes: z.number().int(),
    openingHours: z.record(
      z.enum(WEEKDAYS),
      z.array(z.object({ from: z.string(), to: z.string() })),
    ),
    metadata: metadataSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Resource' });

export const toResource = (doc: ResourceDoc): z.infer<typeof resourceSchema> => ({
  id: doc._id.toHexString(),
  name: doc.name,
  description: doc.description,
  timezone: doc.timezone,
  slotMinutes: doc.slotMinutes,
  openingHours: doc.openingHours,
  metadata: doc.metadata ?? {},
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
});
