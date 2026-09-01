import { HarnessSpecSchema } from "../../projectSchemas/harness";
import type { BuildType } from "../../projectSchemas/runtime";
import type { ExportNote } from "../../core/project/templates/export";
import type { CredentialSchema } from "../../projectSchemas/credential";
import type { PaymentConnectorSchema, PaymentManagerSchema } from "../../projectSchemas/payment";
import type { ConfigBundleSchema } from "../../projectSchemas/config-bundle";
import { MemorySchema } from "../../projectSchemas/memory";
import type { EvaluatorSchema } from "../../projectSchemas/evaluator";
import type { ProjectSpecSchema } from "../../projectSchemas/project";
import z from "zod";
import type { ImportBedrockAgentInput, RuntimeResourceConfig } from "./add/runtime/types";
import type { OnlineEvalConfigSchema } from "../../projectSchemas/online-eval-config";
import { AgentNameSchema, BuildTypeSchema } from "../../projectSchemas/runtime";
import { ProtocolModeSchema, RuntimeVersionSchema } from "../../projectSchemas/constants";
import type { AgentCoreGateway, AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import type { PolicyEngineSchema, PolicySchema } from "../../projectSchemas/policy";
import type { AwsDeploymentTarget } from "../../projectSchemas/aws-targets";

type CreateProjectInputBase = {
  /** The name of the project; also the directory it is scaffolded into. */
  name: string;
  /** Skip installing dependencies (npm install, uv sync). */
  skipInstall?: boolean;
  /** Skip initializing a git repository. */
  skipGit?: boolean;
};

/** Set of arguments needed to scaffold a new Runtime-based agent. */
export const ScaffoldRuntimeInputSchema = z
  .object({
    runtimeName: AgentNameSchema,
    build: BuildTypeSchema,
    language: z.enum(["Python", "TypeScript"]),
    framework: z.enum(["strands", "none"]),
    protocol: ProtocolModeSchema.optional(),
    modelProvider: z.enum(["Bedrock"]),
    apiKey: z.string().min(1).optional(),
    memory: MemorySchema.optional(),
    runtimeVersion: RuntimeVersionSchema.optional(),
  })
  .refine(({ modelProvider, apiKey }) => !(modelProvider === "Bedrock" && apiKey !== undefined), {
    message: "API keys are not compatible with Bedrock model providers",
    path: ["apiKey"],
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
        /** Present when the runtime proxies an imported Bedrock Agent. */
        importBedrockAgent?: ImportBedrockAgentInput;
        scaffoldHarnessInput?: undefined;
      }
    | {
        /** The harness the created project declares (the default create path). */
        scaffoldHarnessInput: ScaffoldHarnessInput;
        scaffoldRuntimeInput?: undefined;
        importBedrockAgent?: undefined;
      }
  );

/** A progress step reported while a long-running project operation runs. */
export type ProjectEvent = {
  message: string;
};

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

export type ResolveDeployedResourceInput = {
  target: string;
  resourceType: ProjectInvokableResource;
  name: string;
};

export type ResolveDeployedResourcesInput = {
  target: string;
  /**
   * When true, an undeployed target resolves to an empty resource list instead
   * of throwing. `project status` wants to render every declared resource as
   * local-only rather than error out before the stack exists; deploy/remove
   * still want the hard failure, so it stays opt-in.
   */
  allowMissing?: boolean;
};

/**
 * Every project resource type that can be surfaced as deployed. Broader than
 * {@link ProjectInvokableResource} (runtime/harness) because `project status`
 * reports the whole stack, not just what you can invoke. Not derived from
 * {@link ProjectResource}: the deployed vocabulary differs (e.g. `payment`, not
 * `payment-manager`/`payment-connector`; adds `knowledge-base` and
 * `capacity-provider`). Datasets are deliberately out of scope for status.
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
  | "payment"
  | "capacity-provider";

export type ResolvedDeployedResource = {
  resourceType: DeployableResource;
  name: string;
  id: string;
  /** Owner name for nested types: policy → engine, gateway-target → gateway. */
  parent?: string;
  target: AwsDeploymentTarget;
};

export type ResolvedDeployedResources = {
  resources: ResolvedDeployedResource[];
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
  };
  /** Name of the runtime agent to generate. */
  targetAgentName: string;
  /** Build override; when absent the harness spec decides (CodeZip unless it demands Container). */
  build?: BuildType;
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
