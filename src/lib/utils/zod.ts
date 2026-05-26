import type { AgentCoreProjectSpec, AgentEnvSpec } from '../../schema';
import { AgentCoreProjectSpecSchema, AgentEnvSpecSchema } from '../../schema';
import { z } from 'zod';

/**
 * Recursively wraps all fields in a Zod schema with `.catch(undefined)` and
 * adds `.loose()` to objects, making parsing lenient — invalid fields
 * are silently dropped and unknown keys are preserved.
 */
export function withCatchAll<T extends z.ZodType>(schema: T): T {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = schema.shape;
    const newShape = Object.fromEntries(
      Object.entries(shape).map(([key, field]) => [key, withCatchAll(field).catch(undefined)])
    );
    return z.object(newShape).loose() as unknown as T;
  }
  if (schema instanceof z.ZodOptional) {
    return z.optional(withCatchAll(schema.unwrap() as z.ZodType)) as unknown as T;
  }
  return schema;
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
