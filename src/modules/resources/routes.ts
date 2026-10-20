import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { DateTime } from 'luxon';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import type { ResourceDoc } from '../../db.js';
import { ApiError, errorResponses, notFound } from '../../errors.js';
import { idParams, idSchema, toObjectId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor, pageSchema, paginationQuery } from '../../lib/pagination.js';
import { freeSlots, localDay } from '../../lib/schedule.js';
import { anyAuth, authOf } from '../../plugins/auth.js';
import { createResourceBody, resourceSchema, toResource, updateResourceBody } from './schemas.js';

const availabilitySchema = z
  .object({
    resourceId: z.string(),
    date: z.iso.date(),
    timezone: z.string(),
    slotMinutes: z.number().int(),
    slots: z.array(
      z.object({
        start: z.string().describe('ISO 8601 with the resource time zone offset'),
        end: z.string(),
      }),
    ),
  })
  .meta({ id: 'Availability' });

const MAX_DAYS_AHEAD = 366;

export const resourceRoutes: FastifyPluginAsyncZod = async (app) => {
  const { resources, bookings } = app.collections;
  app.addHook('onRequest', app.authenticate);

  async function findResource(accountId: ObjectId, id: string): Promise<ResourceDoc> {
    const resource = await resources.findOne({ _id: toObjectId(id), accountId, archivedAt: null });
    if (!resource) throw notFound('Resource');
    return resource;
  }

  app.post(
    '/resources',
    {
      schema: {
        tags: ['Resources'],
        summary: 'Create a bookable resource',
        description: 'A resource is anything that can be booked: a room, a staff member, a court.',
        security: anyAuth,
        body: createResourceBody,
        response: { 201: resourceSchema, ...errorResponses(400, 401, 429) },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const doc: ResourceDoc = {
        _id: new ObjectId(),
        accountId: authOf(request).accountId,
        ...request.body,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      await resources.insertOne(doc);
      return reply
        .status(201)
        .header('location', `/v1/resources/${doc._id.toHexString()}`)
        .send(toResource(doc));
    },
  );

  app.get(
    '/resources',
    {
      schema: {
        tags: ['Resources'],
        summary: 'List resources',
        security: anyAuth,
        querystring: paginationQuery,
        response: { 200: pageSchema(resourceSchema), ...errorResponses(400, 401, 429) },
      },
    },
    async (request) => {
      const { limit, cursor } = request.query;
      const after = cursor ? decodeCursor(cursor, idSchema) : null;
      const docs = await resources
        .find({
          accountId: authOf(request).accountId,
          archivedAt: null,
          ...(after ? { _id: { $gt: toObjectId(after) } } : {}),
        })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .toArray();
      const page = docs.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map(toResource),
        nextCursor: docs.length > limit && last ? encodeCursor(last._id.toHexString()) : null,
      };
    },
  );

  app.get(
    '/resources/:id',
    {
      schema: {
        tags: ['Resources'],
        summary: 'Get a resource',
        security: anyAuth,
        params: idParams,
        response: { 200: resourceSchema, ...errorResponses(400, 401, 404, 429) },
      },
    },
    async (request) => toResource(await findResource(authOf(request).accountId, request.params.id)),
  );

  app.patch(
    '/resources/:id',
    {
      schema: {
        tags: ['Resources'],
        summary: 'Update a resource',
        description: 'Changes apply to new bookings. Existing bookings are kept as they are.',
        security: anyAuth,
        params: idParams,
        body: updateResourceBody,
        response: { 200: resourceSchema, ...errorResponses(400, 401, 404, 429) },
      },
    },
    async (request) => {
      const updated = await resources.findOneAndUpdate(
        {
          _id: toObjectId(request.params.id),
          accountId: authOf(request).accountId,
          archivedAt: null,
        },
        { $set: { ...request.body, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw notFound('Resource');
      return toResource(updated);
    },
  );

  app.delete(
    '/resources/:id',
    {
      schema: {
        tags: ['Resources'],
        summary: 'Archive a resource',
        description: 'Fails while the resource still has upcoming confirmed bookings.',
        security: anyAuth,
        params: idParams,
        response: { 204: z.null(), ...errorResponses(400, 401, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const resource = await findResource(authOf(request).accountId, request.params.id);
      const upcoming = await bookings.countDocuments(
        { resourceId: resource._id, status: 'confirmed', end: { $gt: new Date() } },
        { limit: 1 },
      );
      if (upcoming > 0) {
        throw new ApiError(
          409,
          'resource_has_bookings',
          'Cancel the upcoming bookings before archiving this resource',
        );
      }
      await resources.updateOne({ _id: resource._id }, { $set: { archivedAt: new Date() } });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/resources/:id/availability',
    {
      schema: {
        tags: ['Resources'],
        summary: 'List free slots on a date',
        description: 'The date is a calendar day in the resource time zone.',
        security: anyAuth,
        params: idParams,
        querystring: z.object({ date: z.iso.date().meta({ example: '2026-11-02' }) }),
        response: { 200: availabilitySchema, ...errorResponses(400, 401, 404, 429) },
      },
    },
    async (request) => {
      const resource = await findResource(authOf(request).accountId, request.params.id);
      const { date } = request.query;
      const day = localDay(date, resource.timezone);
      if (!day.start.isValid) throw new ApiError(400, 'invalid_date', 'date is not a valid day');
      const today = DateTime.now().setZone(resource.timezone).startOf('day');
      if (day.start.diff(today, 'days').days > MAX_DAYS_AHEAD) {
        throw new ApiError(400, 'date_out_of_range', `date must be within ${MAX_DAYS_AHEAD} days`);
      }

      const booked = await bookings
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
    },
  );
};
