import { z } from 'zod';

/**
 * Allowed characters for tag keys and values.
 * Matches AWS tagging constraints: Unicode letters, digits, whitespace, _ . : / = + - @
 *
 * NOTE: This schema is duplicated in @aws/agentcore-cdk (src/schema/schemas/primitives/tags.ts).
 * If you change constraints here, update the CDK copy as well.
 */
const TAG_CHAR_PATTERN = /^[\p{L}\p{N}\s_.:/=+\-@]*$/u;

export const TagKeySchema = z
  .string()
  .min(1, 'Tag key is required')
  .max(128, 'Tag key must be 128 characters or less')
  .regex(TAG_CHAR_PATTERN, 'Tag key contains invalid characters')
  .refine(key => key.trim().length > 0, 'Tag key must contain at least one non-whitespace character')
  .refine(key => !key.startsWith('aws:'), 'Tag keys starting with "aws:" are reserved');

export const TagValueSchema = z
  .string()
  .max(256, 'Tag value must be 256 characters or less')
  .regex(TAG_CHAR_PATTERN, 'Tag value contains invalid characters');

export const TagsSchema = z
  .record(TagKeySchema, TagValueSchema)
  .refine(tags => Object.keys(tags).length <= 50, 'Maximum 50 tags per resource');

export type Tags = z.infer<typeof TagsSchema>;
