import { HarnessSpecSchema } from "../../projectSchemas/harness";
import type { ExportNote } from "../../core/project/templates/export";
import type { CredentialSchema } from "../../projectSchemas/credential";
import type { PaymentConnectorSchema, PaymentManagerSchema } from "../../projectSchemas/payment";
import type { ConfigBundleSchema } from "../../projectSchemas/config-bundle";
import { MemorySchema } from "../../projectSchemas/memory";
import type { EvaluatorSchema, EvaluationLevel } from "../../projectSchemas/evaluator";
import type { ProjectSpecSchema } from "../../projectSchemas/project";
import z from "zod";
import type { ImportBedrockAgentInput, RuntimeResourceConfig } from "./add/runtime/types";
import type { OnlineEvalConfigSchema } from "../../projectSchemas/online-eval-config";
import { AgentNameSchema, BuildTypeSchema } from "../../projectSchemas/runtime";
import { ProtocolModeSchema, RuntimeVersionSchema } from "../../projectSchemas/constants";
import type { AgentCoreGateway, AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import type { PolicyEngineSchema, PolicySchema } from "../../projectSchemas/policy";
import type { AwsDeploymentTarget } from "../../projectSchemas/aws-targets";
import type { ProgressEvent } from "../../tui/progress";

type CreateProjectInputBase = {
  /** The name of the project; also the directory it is scaffolded into. */
  name: string;
  /** Skip installing dependencies (npm install, uv sync). */
  skipInstall?: boolean;
  /** Skip initializing a git repository. */
  skipGit?: boolean;
};

export const EVALUATOR_LIBRARIES = ["deepeval", "autoevals"] as const;
export type EvaluatorLibrary = (typeof EVALUATOR_LIBRARIES)[number];

/** Set of arguments needed to scaffold a managed code-based evaluator. */
export type ManagedEvaluatorScaffoldInput = {
  name: string;
  level: EvaluationLevel;
  description?: string;
  kmsKeyArn?: string;
  tags?: Record<string, string>;
  metric?: { library: EvaluatorLibrary; metricClass: string };
  model?: string;
  timeoutSeconds?: number;
};

/** Model providers the scaffolded runtime code can target. */
export const MODEL_PROVIDERS = ["Bedrock", "Anthropic", "OpenAI", "Gemini", "LiteLLM"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

const MODEL_PROVIDER_ALIASES: Record<string, ModelProvider> = {
  bedrock: "Bedrock",
  anthropic: "Anthropic",
  openai: "OpenAI",
  open_ai: "OpenAI",
  gemini: "Gemini",
  litellm: "LiteLLM",
  lite_llm: "LiteLLM",
};

/** Parses a provider name case-insensitively (e.g. `anthropic`), normalizing to canonical casing. */
export const ModelProviderSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? (MODEL_PROVIDER_ALIASES[value.toLowerCase()] ?? value) : value,
  z.enum(MODEL_PROVIDERS),
);

/** Set of arguments needed to scaffold a new Runtime-based agent. */
export const ScaffoldRuntimeInputSchema = z
  .object({
    runtimeName: AgentNameSchema,
    build: BuildTypeSchema,
    language: z.enum(["Python", "TypeScript"]),
    framework: z.enum(["strands", "langchain", "none"]),
    protocol: ProtocolModeSchema.optional(),
    modelProvider: ModelProviderSchema.optional(),
    apiKey: z.string().min(1).optional(),
    memory: MemorySchema.optional(),
    runtimeVersion: RuntimeVersionSchema.optional(),
  })
  .superRefine(({ modelProvider, apiKey }, ctx) => {
    // LiteLLM routes to any provider (Bedrock by default), so its key is optional;
    // the other non-Bedrock providers always call their own API and require one.
    const requiresApiKey =
      modelProvider !== undefined && modelProvider !== "Bedrock" && modelProvider !== "LiteLLM";
    const allowsApiKey = requiresApiKey || modelProvider === "LiteLLM";
    if (apiKey !== undefined && !allowsApiKey) {
      ctx.addIssue({
        code: "custom",
        message: "API keys are not compatible with Bedrock model providers",
        path: ["apiKey"],
      });
    }
    if (apiKey === undefined && requiresApiKey) {
      ctx.addIssue({
        code: "custom",
        message: `an API key is required for the ${modelProvider} model provider`,
        path: ["apiKey"],
      });
    }
  })
  .superRefine(({ build, runtimeVersion }, ctx) => {
    if (build === "CodeZip" && runtimeVersion === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "runtimeVersion is required for CodeZip builds",
        path: ["runtimeVersion"],
      });
    }
    if (build === "Container" && runtimeVersion !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "runtimeVersion is not supported for Container builds",
        path: ["runtimeVersion"],
      });
    }
  });

export type ScaffoldRuntimeInput = z.infer<typeof ScaffoldRuntimeInputSchema>;

/** Set of arguments needed to create a project around a harness. */
export type ScaffoldHarnessInput = z.input<typeof HarnessSpecSchema>;

export type CreateProjectInput = CreateProjectInputBase &
  (
    | {
        /** The resolved template parameters. The handler maps --template to these before calling the manager. */
        scaffoldRuntimeInput: ScaffoldRuntimeInput;
        /** Present when runtime files were translated from a Bedrock Agent version. */
        importBedrockAgent?: ImportBedrockAgentInput;
        scaffoldHarnessInput?: undefined;
      }
    | {
        /** The harness the created project declares (the default create path). */
        scaffoldHarnessInput: ScaffoldHarnessInput;
        scaffoldRuntimeInput?: undefined;
        importBedrockAgent?: undefined;
      }
    | {
        /** The empty template: a project with neither a runtime nor a harness. */
        scaffoldRuntimeInput?: undefined;
        scaffoldHarnessInput?: undefined;
        importBedrockAgent?: undefined;
      }
  );

/**
 * A progress event reported while a long-running project operation runs. The
 * same shape as the generic {@link ProgressEvent} the TUI progress driver
 * consumes: a `step` begins a new unit of work (completing the previous one),
 * an `output` line belongs to the current step, and the final step completes
 * when the generator returns (or fails when it throws).
 */
export type ProjectEvent = ProgressEvent;

/** The destructive deployment discovered after a project has been synthesized. */
export type TeardownConfirmationRequest = {
  projectName: string;
  targetName: string;
  /** Human-readable description of the resources the backend will remove. */
  resourceDescription: string;
  account: string;
  region: string;
};

export type TeardownConfirmationHandler = (
  request: TeardownConfirmationRequest,
) => Promise<boolean>;

export type DeployProjectInput = {
  /** Name of the aws-targets.json entry to deploy. */
  target: string;
  /**
   * The effective AWS region the CLI already resolved (--region flag, env,
   * shared config file). Used to synthesize the default target when
   * aws-targets.json does not define one — never to override a defined target.
   */
  region: string;
  /** Requests approval after the backend discovers that this deploy is a teardown. */
  confirmTeardown: TeardownConfirmationHandler;
};

export type DeployResult = {
  /**
   * Named outputs the deployment produced, e.g. a runtime ARN or a gateway URL.
   * Each backend maps its own notion of outputs into this shape (CDK reads
   * CloudFormation stack outputs; a terraform backend would read `terraform
   * output`), so no individual key is part of the contract — callers render the
   * map rather than indexing into it.
   */
  outputs: Record<string, string>;
  /**
   * Set when the deploy removed the target's stack instead of updating it,
   * because the project no longer declares anything to deploy. Callers report
   * this differently: "deployed" is the wrong word for what happened.
   */
  tornDown?: boolean;
};

export type ResolveProjectInput = {
  /** A path to search from when locating the project root. */
  filePath: string;
};

export type ResolveTargetInput = {
  /** Name of the aws-targets.json entry to look up. */
  target: string;
};

export type ResolveDeployedResourceInput = {
  target: string;
  resourceType: ProjectInvokableResource;
  name: string;
};

export type ResolveDeployedResourcesInput = {
  target: string;
};

export type ResolvedDeployedResource = {
  resourceType: ProjectInvokableResource;
  name: string;
  id: string;
  target: AwsDeploymentTarget;
};

export type ResolvedDeployedResources = {
  resources: ResolvedDeployedResource[];
  target: AwsDeploymentTarget;
};

export type ResolveProjectResourcesInput = {
  /** Name of the aws-targets.json entry to report on. */
  target: string;
};

/**
 * Every resource type a project can declare and deploy. Broader than
 * {@link ProjectInvokableResource}: status reports all of them, while invoke only
 * addresses the two that accept a payload.
 */
export type DeployableResource =
  | "runtime"
  | "harness"
  | "memory"
  | "knowledge-base"
  | "credential"
  | "evaluator"
  | "online-eval"
  | "gateway"
  | "gateway-target"
  | "policy-engine"
  | "policy"
  | "config-bundle"
  | "payment-manager"
  | "payment-connector";

/**
 * A declared resource paired with what the target holds for it. `local-only`
 * means the project declares it but the target's stack has not published it,
 * which is how status distinguishes "not deployed yet" from "not declared".
 */
export type ResolvedProjectResource = {
  resourceType: DeployableResource;
  name: string;
  /**
   * Resources this one contains: a gateway's targets, a policy engine's
   * policies, a payment manager's connectors. The spec says who owns what, so
   * the resolver nests them here and no caller pairs them up by name.
   */
  children?: ResolvedProjectResource[];
} & ({ deploymentState: "deployed"; id: string } | { deploymentState: "local-only" });

export type ResolvedProjectResources = {
  resources: ResolvedProjectResource[];
  target: AwsDeploymentTarget;
};

export type Project = {
  name: string;
  /** Absolute path to the project root (the parent of agentcore/). */
  rootPath: string;
  /** The spec of the project (agentcore.json loaded into memory) */
  spec: z.infer<typeof ProjectSpecSchema>;
};

/** A line to add to agentcore/.env.local. Secret values travel here, never in the spec. */
export type EnvLocalEntry = {
  key: string;
  /** An omitted value writes an empty placeholder the user fills before deploy. */
  value?: string;
  comment: string;
};

/** Discriminated union input for {@link ProjectManager.addResource}. */
export type AddResourceInput =
  | {
      resourceType: "harness";
      resourceConfig: z.input<typeof HarnessSpecSchema>;
    }
  | {
      resourceType: "runtime";
      resourceConfig: RuntimeResourceConfig;
    }
  | {
      resourceType: "credential";
      resourceConfig: z.input<typeof CredentialSchema>;
      envEntries?: EnvLocalEntry[];
    }
  | {
      resourceType: "config-bundle";
      resourceConfig: z.input<typeof ConfigBundleSchema>;
    }
  | {
      resourceType: "online-eval";
      resourceConfig: z.input<typeof OnlineEvalConfigSchema>;
    }
  | {
      resourceType: "online-insight";
      resourceConfig: z.input<typeof OnlineEvalConfigSchema>;
    }
  | {
      resourceType: "memory";
      resourceConfig: z.input<typeof MemorySchema>;
    }
  | {
      resourceType: "evaluator";
      resourceConfig: z.input<typeof EvaluatorSchema>;
      scaffold?: undefined;
    }
  | {
      resourceType: "evaluator";
      resourceConfig: { name: string };
      scaffold: ManagedEvaluatorScaffoldInput;
    }
  | {
      resourceType: "gateway";
      resourceConfig: AgentCoreGateway;
    }
  | {
      resourceType: "gateway-target";
      gatewayName: string;
      resourceConfig: AgentCoreGatewayTarget;
    }
  | {
      resourceType: "policy-engine";
      resourceConfig: z.input<typeof PolicyEngineSchema>;
      attachGateways?: { names: string[]; mode: "ENFORCE" | "LOG_ONLY" };
    }
  | {
      resourceType: "policy";
      engineName: string;
      resourceConfig: z.input<typeof PolicySchema>;
    }
  | {
      resourceType: "payment-manager";
      resourceConfig: z.input<typeof PaymentManagerSchema>;
    }
  | {
      resourceType: "payment-connector";
      managerName: string;
      resourceConfig: z.input<typeof PaymentConnectorSchema>;
    };

export type ProjectResource = AddResourceInput["resourceType"];

/** Input for {@link ProjectManager.exportHarness}. */
export type ExportHarnessInput = {
  /** Name of an in-project harness. Mutually exclusive with `prefetched`. */
  harnessName?: string;
  /** A harness spec + system prompt fetched from the service (the `--arn` path). */
  prefetched?: {
    spec: z.output<typeof HarnessSpecSchema>;
    systemPrompt?: string;
    notes?: ExportNote[];
  };
  /** Name of the runtime agent to generate. */
  targetAgentName: string;
};

/** Result of {@link ProjectManager.exportHarness}. */
export type ExportHarnessResult = {
  harnessName: string;
  agentName: string;
  /** Absolute path of the generated agent directory. */
  agentPath: string;
  /** Absolute path of the EXPORT_NOTES.md file inside it. */
  notesPath: string;
  /** Manual follow-up items also written to EXPORT_NOTES.md. */
  notes: ExportNote[];
};

export type ProjectInvokableResource = Extract<ProjectResource, "harness" | "runtime">;

export type RemoveResourceInput =
  | {
      resourceType:
        | "harness"
        | "runtime"
        | "credential"
        | "config-bundle"
        | "online-eval"
        | "online-insight"
        | "memory"
        | "evaluator"
        | "gateway"
        | "policy-engine"
        | "payment-manager";
      name: string;
    }
  | {
      resourceType: "gateway-target";
      gatewayName: string;
      name: string;
    }
  | {
      resourceType: "policy";
      engineName?: string;
      name: string;
    }
  | {
      resourceType: "payment-connector";
      managerName: string;
      name: string;
    };

/** The outcome of a spec-level removal. */
export type RemoveResourceResult = {
  project: Project;
  /** .env.local keys deleted because the removed credential(s) reserved them. */
  removedEnvKeys: string[];
};

/**
 * The primary interface for interacting with projects
 */
export interface ProjectManager {
  /** Scaffold a new AgentCore project from the given template. */
  create(input: CreateProjectInput): AsyncGenerator<ProjectEvent, Project>;

  /** Compile the project's CDK app and synthesize its CloudFormation templates. */
  build(project: Project): AsyncGenerator<ProjectEvent, void>;

  /** Deploy the project to one of its configured AWS targets. */
  deploy(project: Project, input: DeployProjectInput): AsyncGenerator<ProjectEvent, DeployResult>;

  /**
   * The targets aws-targets.json declares, in file order; empty when the file
   * is absent (deploy then synthesizes the default target on demand).
   */
  listTargets(project: Project): Promise<AwsDeploymentTarget[]>;

  /**
   * Look up a target in aws-targets.json without provisioning or requiring it.
   * Returns undefined when the file or the named entry is absent — unlike
   * deploy, which synthesizes the default target on demand.
   */
  resolveTarget(
    project: Project,
    input: ResolveTargetInput,
  ): Promise<AwsDeploymentTarget | undefined>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;

  /** Resolve a logical project resource to its deployed physical ID and target. */
  resolveDeployedResource(
    project: Project,
    input: ResolveDeployedResourceInput,
  ): Promise<ResolvedDeployedResource>;

  /** Resolve every configured Runtime and Harness present in the deployed target stack. */
  resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesInput,
  ): Promise<ResolvedDeployedResources>;

  /**
   * Resolve every resource the project declares, deployed or not, for the named
   * target. Reports rather than throws when nothing is deployed yet.
   */
  resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesInput,
  ): Promise<ResolvedProjectResources>;

  /** Add a resource to an existing AgentCore project. */
  addResource(project: Project, input: AddResourceInput): AsyncGenerator<ProjectEvent, Project>;

  /**
   * Remove a resource from an existing AgentCore project. Throws
   * ResourceNotFoundError when nothing with the given name exists.
   */
  removeResource(project: Project, input: RemoveResourceInput): Promise<RemoveResourceResult>;

  /**
   * Empty every resource collection in the project spec, leaving name,
   * version, managedBy, and other non-resource fields intact. Spec-level only:
   * code directories under app/ and aws-targets.json survive, so a following
   * deploy can tear down the target's stack.
   */
  removeAllResources(project: Project): Promise<RemoveResourceResult>;

  /**
   * Convert a harness into an editable Strands runtime agent: render the agent
   * code under app/<targetAgentName>/, register the runtime in agentcore.json
   * (the source harness entry is kept), and write EXPORT_NOTES.md for anything
   * that could not be mapped mechanically.
   */
  exportHarness(
    project: Project,
    input: ExportHarnessInput,
  ): AsyncGenerator<ProjectEvent, ExportHarnessResult>;
}
