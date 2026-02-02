import { isReservedProjectName } from '../constants';
import { AgentEnvSpecSchema } from './agent-env';
import { AgentCoreMcpSpecSchema } from './mcp';
import { uniqueBy } from './zod-util';
import { z } from 'zod';

// ============================================================================
// Project Name Schema
// ============================================================================

/**
 * Project name validation (CloudFormation logical ID compatible).
 * Used in CloudFormation stack naming - must start with letter, alphanumeric only.
 * Max 23 chars because runtime names are generated as {projectName}_{runtimeName}
 * and AWS limits agentRuntimeName to 48 characters total.
 *
 * Also validates against reserved names that would conflict with Python packages
 * when creating virtual environments (e.g., 'openai', 'anthropic', 'langchain').
 */
export const ProjectNameSchema = z
  .string()
  .min(1, 'Project name is required')
  .max(23, 'Project name must be 23 characters or less (AWS runtime name limit)')
  .regex(
    /^[A-Za-z][A-Za-z0-9]{0,22}$/,
    'Project name must start with a letter and contain only alphanumeric characters'
  )
  .refine(name => !isReservedProjectName(name), {
    message: 'This name conflicts with a Python package dependency. Please choose a different name.',
  });

// ============================================================================
// Project Spec
// ============================================================================

/**
 * Top level Spec for the Project
 *
 * Only this Spec maintains a version
 * All other specs within it take the same version
 * Version transforms happen at this top level so there is never
 * mismatched schema versions of sub-specs.
 * The main AgentEnvSpec and AgentCoreMcpSpec are 1:1 with the L3
 * CDK constructs
 */
export const AgentCoreProjectSpecSchema = z
  .object({
    name: ProjectNameSchema,
    version: z.string(),
    description: z.string(),
    agents: z.array(AgentEnvSpecSchema).superRefine(
      uniqueBy(
        agent => agent.name,
        name => `Duplicate agent name: ${name}`
      )
    ),
    mcp: AgentCoreMcpSpecSchema.optional(),
  })
  .strict();

export type AgentCoreProjectSpec = z.infer<typeof AgentCoreProjectSpecSchema>;
