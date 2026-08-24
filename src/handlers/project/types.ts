import { HarnessSpecSchema } from "../../projectSchemas/harness";
import type { CredentialSchema } from "../../projectSchemas/credential";
import type { ConfigBundleSchema } from "../../projectSchemas/config-bundle";
import type { MemorySchema } from "../../projectSchemas/memory";
import type { ProjectSpecSchema } from "../../projectSchemas/project";
import z from "zod";
import type { RuntimeResourceConfig } from "./add/runtime/types";
import type { OnlineEvalConfigSchema } from "../../projectSchemas/online-eval-config";

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

export type DeployProjectInput = {
  /** Name of the aws-targets.json entry to deploy. */
  target: string;
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
    };

export type ProjectResource = AddResourceInput["resourceType"];

export type RemoveResourceInput = {
  resourceType: ProjectResource;
  name: string;
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

  /** Add a resource to an existing AgentCore project. */
  addResource(project: Project, input: AddResourceInput): AsyncGenerator<ProjectEvent, Project>;

  /** Remove a resource from an existing AgentCore project. */
  removeResource(project: Project, input: RemoveResourceInput): Promise<Project>;
}
