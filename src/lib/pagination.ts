import { z } from 'zod';
import { ApiError } from '../errors.js';

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page'),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page'),
  });
}

/** Cursors are opaque to clients: base64url-encoded JSON of the last item's sort keys. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.infer<T> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'The cursor is invalid or has expired');
  }
}
