import { HarnessSpecSchema } from "../../projectSchemas/harness";
import type { ProjectSpecSchema } from "../../projectSchemas/project";
import z from "zod";
import { ProjectRuntimeSchema } from "../../projectSchemas/runtime";
import { MemoryStrategyType } from "@aws-sdk/client-bedrock-agentcore-control";

/** Available runtime templates for scaffolding agent code. A subset of {@link PROJECT_TEMPLATES} describing runtimes only */
export const RUNTIME_TEMPLATES = {
  HELLO_WORLD_PYTHON: "hello-world-python",
  HELLO_WORLD_PYTHON_CONTAINER: "hello-world-python-container",
} as const;

export type RuntimeTemplate = (typeof RUNTIME_TEMPLATES)[keyof typeof RUNTIME_TEMPLATES];

/** Available project templates for scaffolding new AgentCore projects. */
export const PROJECT_TEMPLATES = {
  ...RUNTIME_TEMPLATES,
} as const;

export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[keyof typeof PROJECT_TEMPLATES];

export type CreateProjectInput = {
  /** The name of the project; also the directory it is scaffolded into. */
  name: string;
  /** The project template to scaffold from. */
  template: ProjectTemplate;
  /** Skip installing dependencies (npm install, uv sync). */
  skipInstall?: boolean;
  /** Skip initializing a git repository. */
  skipGit?: boolean;
};

/** A progress step reported while a long-running project operation runs. */
export type ProjectEvent = {
  message: string;
};

export type ResolveProjectInput = {
  /** A path to search from when locating the project root. */
  filePath: string;
};

export type Project = {
  name: string;
  /** Absolute path to the project root (the parent of agentcore/). */
  rootPath: string;
  /** The spec of the project (agentcore.json loaded into memory) */
  spec: z.infer<typeof ProjectSpecSchema>;
};

export const runtimeModelProviderSchema = z.enum(["bedrock", "anthropic", "openai", "gemini"]);
export type RuntimeModelProvider = z.infer<typeof runtimeModelProviderSchema>;

export const runtimeModelProviderConfigSchema = z.object({
  provider: runtimeModelProviderSchema.optional(),
  apiKey: z.string().optional(),
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

/** Discriminated union input for {@link ProjectManager.addResource}. */
export type AddResourceInput =
  | {
      resourceType: "harness";
      resourceConfig: z.input<typeof HarnessSpecSchema>;
    }
  | {
      resourceType: "runtime";
      resourceConfig: RuntimeResourceConfig;
    };

export type ProjectResource = AddResourceInput["resourceType"];

/**
 * The primary interface for interacting with projects
 */
export interface ProjectManager {
  /** Scaffold a new AgentCore project from the given template. */
  create(input: CreateProjectInput): AsyncGenerator<ProjectEvent, Project>;

  /** Compile the project's CDK app and synthesize its CloudFormation templates. */
  build(project: Project): AsyncGenerator<ProjectEvent, void>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;

  /** Add a resource to an existing AgentCore project. */
  addResource(project: Project, input: AddResourceInput): AsyncGenerator<ProjectEvent, Project>;
}
