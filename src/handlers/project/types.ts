import z from "zod";

/** Available project templates for scaffolding new AgentCore projects. */
export const PROJECT_TEMPLATES = {
  HELLO_WORLD_PYTHON: "hello-world-python",
  HELLO_WORLD_PYTHON_CONTAINER: "hello-world-python-container",
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

/**
 * The slice of agentcore.json the CLI consumes. Parsing is loose so projects
 * carrying sections we don't read yet (memories, gateways, ...) still resolve.
 */
export const ProjectSpecSchema = z.looseObject({
  name: z.string().min(1),
  runtimes: z
    .array(
      z.looseObject({
        name: z.string().min(1),
        build: z.enum(["CodeZip", "Container"]),
        entrypoint: z.string().min(1),
        codeLocation: z.string().min(1),
        dockerfile: z.string().optional(),
      }),
    )
    .default([]),
});

export type ProjectRuntime = z.infer<typeof ProjectSpecSchema>["runtimes"][number];

export type Project = {
  name: string;
  /** Absolute path to the project root (the parent of agentcore/). */
  rootPath: string;
  /** The runtimes registered in agentcore.json. */
  runtimes: ProjectRuntime[];
};

/**
 * The primary interface for interacting with projects
 */
export interface ProjectManager {
  /** Scaffold a new AgentCore project from the given template. */
  create(input: CreateProjectInput): Promise<Project>;

  /** Locate an existing AgentCore project. Returns undefined if no project can be found. */
  resolve(input: ResolveProjectInput): Promise<Project | undefined>;
}
