import z from "zod";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import { ScaffoldRuntimeInputSchema } from "../../types";
import { BEDROCK_AGENT_IMPORT_REGIONS } from "../../../../core/project/bedrockAgent";

/**
 * The imported Bedrock Agent a proxy runtime wraps: the caller-provided
 * addressing plus the metadata captured from the describe calls.
 */
export const ImportBedrockAgentInputSchema = z.object({
  agentId: z.string().min(1),
  agentAliasId: z.string().min(1),
  region: z.enum(BEDROCK_AGENT_IMPORT_REGIONS),
  agentName: z.string().min(1),
  agentAliasArn: z.string().min(1),
  foundationModel: z.string().optional(),
  description: z.string().optional(),
});
export type ImportBedrockAgentInput = z.infer<typeof ImportBedrockAgentInputSchema>;

const RuntimeInfraConfigSchema = z.object({
  name: ProjectRuntimeSchema.shape.name,
  description: ProjectRuntimeSchema.shape.description,
  executionRoleArn: ProjectRuntimeSchema.shape.executionRoleArn,
  additionalPolicies: ProjectRuntimeSchema.shape.additionalPolicies,
  envVars: ProjectRuntimeSchema.shape.envVars,
  networkMode: ProjectRuntimeSchema.shape.networkMode,
  networkConfig: ProjectRuntimeSchema.shape.networkConfig,
  authorizerType: ProjectRuntimeSchema.shape.authorizerType,
  authorizerConfiguration: ProjectRuntimeSchema.shape.authorizerConfiguration,
  protocol: ProjectRuntimeSchema.shape.protocol,
  requestHeaderAllowlist: ProjectRuntimeSchema.shape.requestHeaderAllowlist,
  lifecycleConfiguration: ProjectRuntimeSchema.shape.lifecycleConfiguration,
  filesystemConfigurations: ProjectRuntimeSchema.shape.filesystemConfigurations,
  tags: ProjectRuntimeSchema.shape.tags,
});

export const RuntimeResourceConfigSchema = RuntimeInfraConfigSchema.extend({
  scaffoldRuntimeInput: ScaffoldRuntimeInputSchema,
  /** Present when the runtime is a proxy for an imported Bedrock Agent. */
  importBedrockAgent: ImportBedrockAgentInputSchema.optional(),
});
export type RuntimeResourceConfig = z.infer<typeof RuntimeResourceConfigSchema>;
