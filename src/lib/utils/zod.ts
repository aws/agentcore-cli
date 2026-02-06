import type { AgentCoreProjectSpec, AgentEnvSpec } from '../../schema';
import { AgentCoreProjectSpecSchema, AgentEnvSpecSchema } from '../../schema';

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
