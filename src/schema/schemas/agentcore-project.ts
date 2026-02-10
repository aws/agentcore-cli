/**
 * AgentCore Project Schema - Resource-centric model
 *
 * Flat resource model where agents, memories, and credentials are top-level.
 * All resources within a project implicitly have access to each other.
 *
 * @module agentcore-project
 */
import { isReservedProjectName } from '../constants';
import { AgentEnvSpecSchema } from './agent-env';
import { DEFAULT_STRATEGY_NAMESPACES, MemoryStrategySchema, MemoryStrategyTypeSchema } from './primitives/memory';
import { uniqueBy } from './zod-util';
import { z } from 'zod';

// Re-export for convenience
export { DEFAULT_STRATEGY_NAMESPACES, MemoryStrategySchema, MemoryStrategyTypeSchema };
export type { MemoryStrategy, MemoryStrategyType } from './primitives/memory';

// ============================================================================
// Project Name Schema
// ============================================================================

export const ProjectNameSchema = z
  .string()
  .min(1, 'Project name is required')
  .max(23, 'Project name must be 23 characters or less')
  .regex(
    /^[A-Za-z][A-Za-z0-9]{0,22}$/,
    'Project name must start with a letter and contain only alphanumeric characters'
  )
  .refine(name => !isReservedProjectName(name), {
    message: 'This name conflicts with a Python package dependency. Please choose a different name.',
  });

// ============================================================================
// Memory Schema
// ============================================================================

export const MemoryTypeSchema = z.literal('AgentCoreMemory');
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const MemorySchema = z.object({
  type: MemoryTypeSchema,
  name: MemoryNameSchema,
  eventExpiryDuration: z.number().int().min(7).max(365),
  // Strategies array can be empty for short-term memory (just base memory with expiration)
  // Long-term memory includes strategies like SEMANTIC, SUMMARIZATION, USER_PREFERENCE
  strategies: z
    .array(MemoryStrategySchema)
    .default([])
    .superRefine(
      uniqueBy(
        strategy => strategy.type,
        type => `Duplicate memory strategy type: ${type}`
      )
    ),
});

export type Memory = z.infer<typeof MemorySchema>;

// ============================================================================
// Credential Schema
// ============================================================================

export const CredentialTypeSchema = z.literal('ApiKeyCredentialProvider');
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

export const CredentialNameSchema = z
  .string()
  .min(3, 'Credential name must be at least 3 characters')
  .max(255)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    'Must contain only alphanumeric characters, underscores, dots, and hyphens (3-255 chars)'
  );

export const CredentialSchema = z.object({
  type: CredentialTypeSchema,
  name: CredentialNameSchema,
});

export type Credential = z.infer<typeof CredentialSchema>;

// ============================================================================
// Project Schema (Top Level)
// ============================================================================

export const AgentCoreProjectSpecSchema = z.object({
  name: ProjectNameSchema,
  version: z.number().int(),

  agents: z
    .array(AgentEnvSpecSchema)
    .default([])
    .superRefine(
      uniqueBy(
        agent => agent.name,
        name => `Duplicate agent name: ${name}`
      )
    ),

  memories: z
    .array(MemorySchema)
    .default([])
    .superRefine(
      uniqueBy(
        memory => memory.name,
        name => `Duplicate memory name: ${name}`
      )
    ),

  credentials: z
    .array(CredentialSchema)
    .default([])
    .superRefine(
      uniqueBy(
        credential => credential.name,
        name => `Duplicate credential name: ${name}`
      )
    ),
});

export type AgentCoreProjectSpec = z.infer<typeof AgentCoreProjectSpecSchema>;
