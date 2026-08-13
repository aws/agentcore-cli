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

/**
 * A progress step reported while a long-running project operation runs, or a line
 * of output from the tool it drives. One of the two is set per event: a step is
 * this CLI's own wording, while output is forwarded as the tool phrased it.
 */
export type ProjectEvent = {
  message?: string;
  output?: string;
};

export type DeployProjectOptions = {
  /** The resolved AWS region, forwarded to the CDK subprocesses. */
  region: string;
  /** Skip bootstrapping the target environments before deploying. */
  skipBootstrap: boolean;
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

  /** Compile the project's CDK app and synthesize its CloudFormation templates. */
  build(project: Project): AsyncGenerator<ProjectEvent, void>;

  /** Build the project, then deploy the synthesized stacks to its deployment targets. */
  deploy(project: Project, options: DeployProjectOptions): AsyncGenerator<ProjectEvent, void>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;

  /** Add a resource to an existing AgentCore project. */
  addResource<TResource extends ProjectResource>(
    project: Project,
    resourceType: TResource,
    resourceConfig: ProjectResourceConfig<TResource>,
  ): AsyncGenerator<ProjectEvent, Project>;
}
