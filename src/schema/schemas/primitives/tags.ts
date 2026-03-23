import { z } from 'zod';

const TAG_CHAR_PATTERN = /^[\p{L}\p{N}\s_.:/=+\-@]+$/u;
const TAG_CHAR_MESSAGE = 'can only contain Unicode letters, digits, whitespace, and _ . : / = + - @';

export const TagKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/\S/, 'Tag key must contain at least one non-whitespace character')
  .regex(TAG_CHAR_PATTERN, `Tag key ${TAG_CHAR_MESSAGE}`)
  .refine(key => !key.startsWith('aws:'), 'Tag keys starting with "aws:" are reserved');

const TAG_VALUE_CHAR_PATTERN = /^[\p{L}\p{N}\s_.:/=+\-@]*$/u;

export const TagValueSchema = z.string().max(256).regex(TAG_VALUE_CHAR_PATTERN, `Tag value ${TAG_CHAR_MESSAGE}`);

export const TagsSchema = z
  .record(TagKeySchema, TagValueSchema)
  .refine(tags => Object.keys(tags).length <= 50, 'A resource can have at most 50 tags')
  .optional();

export type Tags = z.infer<typeof TagsSchema>;
