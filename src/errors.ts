import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** An error that is safe to show to API clients. Anything else becomes a 500. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'validation_error' }),
      message: z.string(),
      details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
      requestId: z.string(),
    }),
  })
  .meta({ id: 'Error' });

/** Response schemas for error status codes, so they show up in the OpenAPI docs. */
export function errorResponses<const S extends readonly number[]>(...statuses: S) {
  return Object.fromEntries(statuses.map((status) => [status, errorSchema])) as {
    [K in S[number]]: typeof errorSchema;
  };
}

function body(request: FastifyRequest, code: string, message: string, details?: ErrorDetail[]) {
  return { error: { code, message, ...(details ? { details } : {}), requestId: request.id } };
}

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    return reply
      .status(error.statusCode)
      .send(body(request, error.code, error.message, error.details));
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = error.validation.map((issue) => ({
      path: [error.validationContext, ...issue.instancePath.split('/').filter(Boolean)].join('.'),
      message: issue.message ?? 'Invalid value',
    }));
    return reply
      .status(400)
      .send(body(request, 'validation_error', 'Request validation failed', details));
  }

  if (isResponseSerializationError(error)) {
    request.log.error({ err: error, issues: error.cause.issues }, 'response failed validation');
    return reply.status(500).send(body(request, 'internal_error', 'Something went wrong'));
  }

  // Errors Fastify raises itself, e.g. malformed JSON or an unsupported content type.
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.status(error.statusCode).send(body(request, 'bad_request', error.message));
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.status(500).send(body(request, 'internal_error', 'Something went wrong'));
}
