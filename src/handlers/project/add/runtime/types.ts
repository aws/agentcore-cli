import { MemoryStrategyType } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import { RUNTIME_TEMPLATES } from "../../types";

export const runtimeModelProviderSchema = z.enum(["bedrock", "anthropic", "openai", "gemini"]);
export type RuntimeModelProvider = z.infer<typeof runtimeModelProviderSchema>;

export const runtimeModelProviderConfigSchema = z.object({
  provider: runtimeModelProviderSchema.optional(),
  apiKey: z.string().min(1).optional(),
});
export type RuntimeModelProviderConfig = z.infer<typeof runtimeModelProviderConfigSchema>;

export const runtimeMemoryConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }),
  z.object({
    mode: z.literal("create"),
    strategies: z.array(z.enum(Object.values(MemoryStrategyType))),
  }),
  z.object({
    mode: z.literal("existing"),
    arn: z.string().min(1),
  }),
]);
export type RuntimeMemoryConfig = z.input<typeof runtimeMemoryConfigSchema>;

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

const RuntimeByoConfigSchema = RuntimeInfraConfigSchema.extend({
  source: z.literal("byo"),
  codeLocation: z.string().min(1),
  build: ProjectRuntimeSchema.shape.build.optional(),
  entrypoint: ProjectRuntimeSchema.shape.entrypoint.optional(),
  runtimeVersion: ProjectRuntimeSchema.shape.runtimeVersion,
  dockerfile: ProjectRuntimeSchema.shape.dockerfile,
  buildContextPath: ProjectRuntimeSchema.shape.buildContextPath,
  customDockerBuildArgs: ProjectRuntimeSchema.shape.customDockerBuildArgs,
});

const RuntimeTemplateConfigSchema = RuntimeInfraConfigSchema.extend({
  source: z.literal("template"),
  template: z.enum(RUNTIME_TEMPLATES),
  memory: runtimeMemoryConfigSchema.optional(),
  modelProvider: runtimeModelProviderConfigSchema.optional(),
});

export const RuntimeResourceConfigSchema = z.discriminatedUnion("source", [
  RuntimeByoConfigSchema,
  RuntimeTemplateConfigSchema,
]);
export type RuntimeResourceConfig = z.infer<typeof RuntimeResourceConfigSchema>;
