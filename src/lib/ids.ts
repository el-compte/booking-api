import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex id')
  .meta({ example: '6716a9f2c3b1e4a5d6f70812' });

export const idParams = z.object({ id: idSchema });

export const toObjectId = (id: string) => new ObjectId(id);
