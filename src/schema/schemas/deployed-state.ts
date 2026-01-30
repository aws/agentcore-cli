import { DeploymentTargetNameSchema } from './aws-targets';
import { z } from 'zod';

// ============================================================================
// Agent Deployed State
// ============================================================================

export const AgentCoreDeployedStateSchema = z.object({
  runtimeId: z.string().min(1),
  runtimeArn: z.string().min(1),
  roleArn: z.string().min(1),
  sessionId: z.string().optional(),
  memoryIds: z.array(z.string()).optional(),
  browserId: z.string().optional(),
  codeInterpreterId: z.string().optional(),
});

export type AgentCoreDeployedState = z.infer<typeof AgentCoreDeployedStateSchema>;

// ============================================================================
// MCP Gateway Deployed State
// ============================================================================

export const GatewayDeployedStateSchema = z.object({
  gatewayId: z.string().min(1),
  gatewayArn: z.string().min(1),
});

export type GatewayDeployedState = z.infer<typeof GatewayDeployedStateSchema>;

// ============================================================================
// MCP Runtime Deployed State
// ============================================================================

export const McpRuntimeDeployedStateSchema = z.object({
  runtimeId: z.string().min(1),
  runtimeArn: z.string().min(1),
  runtimeEndpoint: z.string().min(1),
});

export type McpRuntimeDeployedState = z.infer<typeof McpRuntimeDeployedStateSchema>;

// ============================================================================
// MCP Lambda Deployed State
// ============================================================================

export const McpLambdaDeployedStateSchema = z.object({
  functionArn: z.string().min(1),
  functionName: z.string().min(1),
});

export type McpLambdaDeployedState = z.infer<typeof McpLambdaDeployedStateSchema>;

// ============================================================================
// MCP Deployed State Container
// ============================================================================

export const McpDeployedStateSchema = z.object({
  gateways: z.record(z.string(), GatewayDeployedStateSchema).optional(),
  runtimes: z.record(z.string(), McpRuntimeDeployedStateSchema).optional(),
  lambdas: z.record(z.string(), McpLambdaDeployedStateSchema).optional(),
});

export type McpDeployedState = z.infer<typeof McpDeployedStateSchema>;

// ============================================================================
// Externally Managed Resources
// ============================================================================

export const ExternallyManagedResourceSchema = z.object({
  name: z.string().min(1),
});

export type ExternallyManagedResource = z.infer<typeof ExternallyManagedResourceSchema>;

export const CustomJwtAuthorizerSchema = ExternallyManagedResourceSchema.extend({
  allowedAudience: z.array(z.string()),
  allowedClients: z.array(z.string()),
  discoveryUrl: z.string(),
});

export type CustomJwtAuthorizer = z.infer<typeof CustomJwtAuthorizerSchema>;

export const VpcConfigSchema = ExternallyManagedResourceSchema.extend({
  securityGroups: z.array(z.string()),
  subnets: z.array(z.string()),
});

export type VpcConfig = z.infer<typeof VpcConfigSchema>;

export const ExternallyManagedStateSchema = z.object({
  customJwtAuthorizer: CustomJwtAuthorizerSchema.optional(),
  vpcConfig: VpcConfigSchema.optional(),
});

export type ExternallyManagedState = z.infer<typeof ExternallyManagedStateSchema>;

// ============================================================================
// Deployed Resource State
// ============================================================================

export const DeployedResourceStateSchema = z.object({
  agents: z.record(z.string(), AgentCoreDeployedStateSchema).optional(),
  mcp: McpDeployedStateSchema.optional(),
  externallyManaged: ExternallyManagedStateSchema.optional(),
  stackName: z.string().optional(),
});

export type DeployedResourceState = z.infer<typeof DeployedResourceStateSchema>;

// ============================================================================
// Target Deployed State
// ============================================================================

export const TargetDeployedStateSchema = z.object({
  resources: DeployedResourceStateSchema.optional(),
});

export type TargetDeployedState = z.infer<typeof TargetDeployedStateSchema>;

// ============================================================================
// Root Deployed State
// ============================================================================

/**
 * Type alias for deployment target name (maps to aws-targets name field).
 */
export type DeploymentTargetName = string;

export const DeployedStateSchema = z.object({
  targets: z.record(DeploymentTargetNameSchema, TargetDeployedStateSchema),
});

export type DeployedState = z.infer<typeof DeployedStateSchema>;

/**
 * Creates a DeployedState schema that validates target keys against aws-targets.
 * Ensures all keys in deployed-state exist as names in aws-targets.
 */
export function createValidatedDeployedStateSchema(targetNames: string[]) {
  const targetNameSet = new Set(targetNames);

  return DeployedStateSchema.refine(
    state => {
      const stateKeys = Object.keys(state.targets);
      return stateKeys.every(key => targetNameSet.has(key));
    },
    {
      message: 'Deployed state contains target names not present in aws-targets',
    }
  );
}
