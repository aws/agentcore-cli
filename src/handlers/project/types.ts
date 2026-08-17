import { HarnessSpecSchema } from "../../projectSchemas/harness";
import type { ProjectSpecSchema } from "../../projectSchemas/project";
import type z from "zod";
import type { ProjectRuntimeSchema } from "../../projectSchemas/runtime";

/** Available project templates for scaffolding new AgentCore projects. */
export const PROJECT_TEMPLATES = {
  HELLO_WORLD_PYTHON: "hello-world-python",
  HELLO_WORLD_PYTHON_CONTAINER: "hello-world-python-container",
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

/** Progress worth showing while a long-running project operation runs. */
export type ProjectStep = {
  kind: "step";
  message: string;
};

/** What a deploy left behind: the deployed stack's outputs, keyed as the stack names them. */
export type ProjectOutputs = {
  kind: "outputs";
  outputs: Record<string, string>;
};

/** Anything a project operation reports as it runs. Only deploy has outputs to report. */
export type ProjectEvent = ProjectStep | ProjectOutputs;

export type DeployProjectInput = {
  /** The resolved AWS region the deployment tooling makes its own calls in. */
  region: string;
  /** Name of the aws-targets.json entry to deploy. */
  target: string;
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

/** Discriminated union input for {@link ProjectManager.addResource}. */
export type AddResourceInput =
  | {
      resourceType: "harness";
      resourceConfig: z.input<typeof HarnessSpecSchema>;
    }
  | {
      resourceType: "runtime";
      resourceConfig: z.input<typeof ProjectRuntimeSchema>;
    };

export type ProjectResource = AddResourceInput["resourceType"];

/**
 * The primary interface for interacting with projects
 */
export interface ProjectManager {
  /** Scaffold a new AgentCore project from the given template. */
  create(input: CreateProjectInput): AsyncGenerator<ProjectStep, Project>;

  /** Build the project's deployable artifacts with whatever backend owns them. */
  build(project: Project): AsyncGenerator<ProjectStep, void>;

  /** Build the project, then deploy it to one of its deployment targets. */
  deploy(project: Project, input: DeployProjectInput): AsyncGenerator<ProjectEvent, void>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;

  /** Add a resource to an existing AgentCore project. */
  addResource(project: Project, input: AddResourceInput): AsyncGenerator<ProjectStep, Project>;
}
