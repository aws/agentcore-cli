import { z } from "zod";
const TAG_CHAR_PATTERN = /^[\p{L}\p{N}\s_.:/=+\-@]*$/u;
export const TagKeySchema = z
  .string()
  .min(1, "Tag key is required")
  .max(128, "Tag key must be 128 characters or less")
  .regex(TAG_CHAR_PATTERN, "Tag key contains invalid characters")
  .refine(
    (key) => key.trim().length > 0,
    "Tag key must contain at least one non-whitespace character",
  )
  .refine((key) => !key.startsWith("aws:"), 'Tag keys starting with "aws:" are reserved');
export const TagValueSchema = z
  .string()
  .max(256, "Tag value must be 256 characters or less")
  .regex(TAG_CHAR_PATTERN, "Tag value contains invalid characters");
/** The most tags AWS takes on one resource. */
export const MAX_TAGS = 50;
export const TagsSchema = z
  .record(TagKeySchema, TagValueSchema)
  .refine((tags) => Object.keys(tags).length <= MAX_TAGS, `Maximum ${MAX_TAGS} tags per resource`);
export type Tags = z.infer<typeof TagsSchema>;
/**
 * The tag key that names the family of CLI templates a resource was made from: `strands-box` for a
 * Box template, `BedrockManagedAgents` for the BMA template. `isBmaRuntime` reads it.
 */
export const TEMPLATE_TAG_KEY = "agentcore:template";
