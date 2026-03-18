import { z } from 'zod';

export const TagKeySchema = z.string().min(1).max(128);
export const TagValueSchema = z.string().max(256);
export const TagsSchema = z.record(TagKeySchema, TagValueSchema).optional();
export type Tags = z.infer<typeof TagsSchema>;
