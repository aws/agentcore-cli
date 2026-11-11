import z from "zod";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import { ScaffoldRuntimeInputSchema } from "../../types";
import { BedrockAgentImportPlanSchema } from "../../../../core/project/bedrockAgentImport";

export const ImportBedrockAgentInputSchema = BedrockAgentImportPlanSchema;
export type ImportBedrockAgentInput = z.infer<typeof ImportBedrockAgentInputSchema>;

const RuntimeInfraConfigSchema = z.object({
  name: ProjectRuntimeSchema.shape.name,
  description: ProjectRuntimeSchema.shape.description,
  executionRoleArn: ProjectRuntimeSchema.shape.executionRoleArn,
  containerBuildRoleArn: ProjectRuntimeSchema.shape.containerBuildRoleArn,
  containerBuildHandlerRoleArn: ProjectRuntimeSchema.shape.containerBuildHandlerRoleArn,
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
  /** Present when runtime files were translated from a Bedrock Agent version. */
  importBedrockAgent: ImportBedrockAgentInputSchema.optional(),
}).superRefine((runtime, ctx) => {
  for (const field of ["containerBuildRoleArn", "containerBuildHandlerRoleArn"] as const) {
    if (runtime[field] && runtime.scaffoldRuntimeInput.build !== "Container") {
      ctx.addIssue({
        code: "custom",
        message: `${field} is only allowed for Container builds`,
        path: [field],
      });
    }
  }
});
export type RuntimeResourceConfig = z.infer<typeof RuntimeResourceConfigSchema>;

/**
 * A runtime added without code: the CLI writes README.md and AGENTS.md for the
 * language and protocol into app/<name>/, and the user (or their coding agent)
 * writes the code. The spec entry starts with default build settings, which
 * dev, build, and deploy update from the code.
 */
export const RuntimeDocsConfigSchema = RuntimeInfraConfigSchema.extend({
  language: z.enum(["Python", "TypeScript"]),
});
export type RuntimeDocsConfig = z.infer<typeof RuntimeDocsConfigSchema>;

/** Whether an added runtime only gets docs (as opposed to scaffolded code). */
export function isRuntimeDocsConfig(
  config: RuntimeResourceConfig | RuntimeDocsConfig,
): config is RuntimeDocsConfig {
  return !("scaffoldRuntimeInput" in config);
}
