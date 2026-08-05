import z from "zod";

/** Available project templates for scaffolding new AgentCore projects. */
export const PROJECT_TEMPLATES = {
  HELLO_WORLD_PYTHON: "hello-world-python",
} as const;

export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[keyof typeof PROJECT_TEMPLATES];

// A generated project's Python package is named after the
// project, so a name that collides with a dependency breaks imports.
const RESERVED_PROJECT_NAMES: readonly string[] = [
  // Core SDK packages
  "anthropic",
  "autogen",
  "autogenagentchat",
  "autogenext",
  "bedrock",
  "bedrockagentcore",
  "crewai",
  "crewaitools",
  "googleadk",
  "googlegenerativeai",
  "langchain",
  "langchainanthropic",
  "langchainaws",
  "langchaingooglegenai",
  "langchainmcpadapters",
  "langchainopenai",
  "langgraph",
  "mcp",
  "openai",
  "openaiagents",
  "strands",
  "strandsagents",
  "strandsagentstools",
  // AG-UI adapter packages
  "agui",
  "aguistrands",
  "aguilanggraph",
  "aguiadk",
  "aguiprotocol",
  "vercelai",
  "aisdk",
  // Common utilities
  "httpx",
  "pytest",
  "pytestasyncio",
  "pythondotenv",
  "tiktoken",
  // Build tools
  "hatchling",
  "setuptools",
  "wheel",
  // AWS packages
  "awsopentelemetrydistro",
  "boto3",
  "botocore",
  // Common Python stdlib/package names that could cause issues
  "test",
  "tests",
  "src",
  "lib",
  "dist",
  "build",
  "env",
  "venv",
  "site",
  "pip",
  "uv",
];

// Mirrors ProjectNameSchema in @aws/agentcore-cdk
export const ProjectNameSchema = z
  .string()
  .min(1, "project name is required")
  .max(23, "project name must be 23 characters or less")
  .regex(
    /^[A-Za-z][A-Za-z0-9]{0,22}$/,
    "project name must start with a letter and contain only letters and digits",
  )
  .refine((name) => !RESERVED_PROJECT_NAMES.includes(name.toLowerCase()), {
    message: "this name conflicts with a Python package dependency; choose a different name",
  });

export type CreateProjectInput = {
  /** The name of the project; also the directory it is scaffolded into. */
  name: string;
  /** The project template to scaffold from. */
  template: ProjectTemplate;
  /** Skip installing dependencies (npm install, uv sync). */
  skipInstall?: boolean;
  /** Skip initializing a git repository. */
  skipGit?: boolean;
  /** Called as each creation step begins; drives progress output. */
  onProgress?: (event: CreateProgressEvent) => void;
};

/** A progress update emitted as a creation step begins. */
export type CreateProgressEvent = {
  /** Human-readable description of the step. */
  message: string;
};

export type ResolveProjectInput = {
  /** A path to search from when locating the project root. */
  filePath: string;
};

export type DeploymentTarget = {
  name: string;
  description?: string;
  account: string;
  region: string;
};

export type Project = {
  name: string;
  root: string;
  configDir: string;
  managedBy: string;
  targets: DeploymentTarget[];
};

export type ProjectProgressEvent = {
  message: string;
};

export type BuildProjectInput = {
  /** A path to search from when locating the project root. */
  filePath: string;
  /** Called as each build step begins. */
  onProgress?: (event: ProjectProgressEvent) => void;
};

export type BuildArtifact = {
  type: "cdk-cloud-assembly";
  path: string;
  stacks: Record<string, string>;
};

export type BuildManifest = {
  version: 1;
  projectName: string;
  backend: string;
  cliVersion: string;
  inputFingerprint: string;
  builtAt: string;
  artifact: BuildArtifact;
  targets: DeploymentTarget[];
};

export type BuildProjectResult = BuildManifest & {
  manifestPath: string;
};

/**
 * The primary interface for interacting with projects
 */
export interface ProjectManager {
  /** Scaffold a new AgentCore project from the given template. */
  create(input: CreateProjectInput): Promise<Project>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;

  /** Validate and build all deployable artifacts for a project. */
  build(input: BuildProjectInput): Promise<BuildProjectResult>;
}
