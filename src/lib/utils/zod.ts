import type { AgentCoreProjectSpec, AgentEnvSpec } from '../../schema';
import { AgentCoreProjectSpecSchema, AgentEnvSpecSchema } from '../../schema';
import { z } from 'zod';

export interface ResilientParseOptions {
  /** Value to use when a field fails validation. Default: undefined */
  fallback?: string | number | boolean;
  /** Include schema keys not present in data, set to fallback value. Default: false */
  fillMissing?: boolean;
  /** Preserve keys in data not defined in the schema. Default: true */
  keepUnknown?: boolean;
}

/**
 * Recursively parse data against a Zod object schema, field by field.
 * Invalid fields fall back to a default value rather than throwing.
 * Nested ZodObjects are parsed recursively.
 *
 */
export function resilientParse<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  data: Record<string, unknown>,
  options: ResilientParseOptions = {}
): Partial<z.infer<T>> {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return {} as Partial<z.infer<T>>;
  const { fallback, fillMissing = false, keepUnknown = true } = options;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (!(key in data)) {
      if (fillMissing) result[key] = fallback;
      continue;
    }
    const value = data[key];
    const inner = unwrapZodType(field as z.ZodType);
    if (inner instanceof z.ZodObject && value != null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = resilientParse(inner, value as Record<string, unknown>, options);
    } else {
      const parsed = (field as z.ZodType).safeParse(value);
      result[key] = parsed.success ? parsed.data : fallback;
    }
  }
  if (keepUnknown) {
    for (const key of Object.keys(data)) {
      if (!(key in schema.shape)) {
        result[key] = data[key];
      }
    }
  }
  return result as Partial<z.infer<T>>;
}

/** Unwrap ZodOptional, ZodNullable, and ZodDefault to get the inner type. */
function unwrapZodType(field: z.ZodType): z.ZodType {
  while (field instanceof z.ZodOptional || field instanceof z.ZodNullable || field instanceof z.ZodDefault) {
    field = field.unwrap() as z.ZodType;
  }
  return field;
}

/**
 * Pass agent spec through zod validator
 * @param spec Agent spec to validate
 * @returns Validated AgentEnvSpec
 */
export function validateAgentSchema(spec: unknown): AgentEnvSpec {
  const validationResult = AgentEnvSpecSchema.safeParse(spec);
  if (!validationResult.success) {
    const errors = validationResult.error.issues.map(e => `${String(e.path.join('.'))}: ${e.message}`).join('; ');
    throw new Error(`Invalid AgentEnvSpec: ${errors}`);
  }
  return validationResult.data;
}

/**
 * Pass project spec through zod validator
 * @param spec Project spec to validate
 * @returns Validated AgentCoreProjectSpec
 */
export function validateProjectSchema(spec: unknown): AgentCoreProjectSpec {
  const validationResult = AgentCoreProjectSpecSchema.safeParse(spec);
  if (!validationResult.success) {
    const errors = validationResult.error.issues.map(e => `${String(e.path.join('.'))}: ${e.message}`).join('; ');
    throw new Error(`Invalid AgentCoreProjectSpec: ${errors}`);
  }
  return validationResult.data;
}
