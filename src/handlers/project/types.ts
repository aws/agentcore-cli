import { HarnessSpecSchema } from "../../projectSchemas/harness";
import type { ManagedBy } from "../../projectSchemas/project";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type z from "zod";

/** Available project templates for scaffolding new AgentCore projects. */
export const PROJECT_TEMPLATES = {
  HELLO_WORLD_PYTHON: "hello-world-python",
  HELLO_WORLD_PYTHON_CONTAINER: "hello-world-python-container",
} as const;

export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[keyof typeof PROJECT_TEMPLATES];

/** Resources that may be added to an agentcore project **/
export const PROJECT_RESOURCE_TYPES = {
  harness: { schema: HarnessSpecSchema },
};

export type ProjectResource = keyof typeof PROJECT_RESOURCE_TYPES;
export type ProjectResourceConfig<TResource extends ProjectResource> = z.input<
  (typeof PROJECT_RESOURCE_TYPES)[TResource]["schema"]
>;

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
export type ProjectEvent = {
  /** Discriminated so a later variant can carry fields a step has no use for. */
  kind: "step";
  message: string;
};

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
  /** The infrastructure backend that owns the project's deployable artifacts. */
  managedBy: ManagedBy;
  /** The runtimes registered in agentcore.json. */
  runtimes: ProjectRuntime[];
};

/**
 * The primary interface for interacting with projects
 */
export interface ProjectManager {
  /** Scaffold a new AgentCore project from the given template. */
  create(input: CreateProjectInput): AsyncGenerator<ProjectEvent, Project>;

  /** Build the project's deployable artifacts with whatever backend owns them. */
  build(project: Project): AsyncGenerator<ProjectEvent, void>;

  /** Build the project, then deploy it to one of its deployment targets. */
  deploy(project: Project, input: DeployProjectInput): AsyncGenerator<ProjectEvent, void>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;

  /** Add a resource to an existing AgentCore project. */
  addResource<TResource extends ProjectResource>(
    project: Project,
    resourceType: TResource,
    resourceConfig: ProjectResourceConfig<TResource>,
  ): AsyncGenerator<ProjectEvent, Project>;
}
