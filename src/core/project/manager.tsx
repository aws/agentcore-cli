import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { InputValidationError, NestedProjectError } from "../../errors";
import type {
  BuildManifest,
  BuildProjectInput,
  BuildProjectResult,
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import { atomicWrite, requireTool, runProcess, type ProcessRunner } from "../../io";
import { PACKAGE_VERSION } from "../../constants";
import { projectTree } from "./compose";
import { defaultSource, type AssetSource } from "./source";
import { TEMPLATES } from "./templates";
import { writeTree } from "./tree";
import { CdkProjectBackend } from "./cdk";
import type { ProjectBuildBackend } from "./backend";
import { computeProjectFingerprint } from "./fingerprint";
import { DeploymentTargetsSchema, ProjectSpecEnvelopeSchema } from "./schemas";

/** Walks up from directory looking for the agentcore/agentcore.json project marker. */
function enclosingProjectRoot(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, "agentcore", "agentcore.json"))) {
      return current;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
  now?: () => Date;
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: AssetSource;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly now: () => Date;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.now = config.now ?? (() => new Date());
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const candidate = resolve(input.filePath);
    let directory = candidate;
    try {
      if ((await stat(candidate)).isFile()) directory = dirname(candidate);
    } catch {
      // A non-existent path can still identify a directory beneath an enclosing project.
    }

    const root = enclosingProjectRoot(directory);
    if (!root) return undefined;

    return this.loadProject(root);
  }

  public async create(input: CreateProjectInput): Promise<Project> {
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
    const enclosing = enclosingProjectRoot(process.cwd());
    if (enclosing) {
      throw new NestedProjectError(enclosing);
    }
    const destination = join(process.cwd(), input.name);
    this.logger.debug(`scaffolding project "${input.name}" from template "${input.template}"`);

    input.onProgress?.({ message: "Scaffolding project files..." });
    const tree = await projectTree(input.name, input.template, this.source);
    await writeTree(tree, destination);

    // A failed step leaves the scaffolded files in place; the error tells the
    // user how to rerun the step by hand.
    if (!input.skipInstall) {
      await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
      input.onProgress?.({ message: "Installing CDK dependencies (npm install)..." });
      await this.run(["npm", "install"], join(destination, "agentcore", "cdk"));

      const appDir = join(destination, "app", TEMPLATES[input.template].appDir);
      if (existsSync(join(appDir, "pyproject.toml"))) {
        await this.checkTool(
          "uv",
          "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
        );
        input.onProgress?.({ message: "Syncing Python dependencies (uv sync)..." });
        await this.run(["uv", "sync"], appDir);
      }
    }

    if (!input.skipGit) {
      await this.checkTool("git", "Install git: https://git-scm.com/downloads");
      input.onProgress?.({ message: "Initializing git repository..." });
      await this.run(["git", "init"], destination);
    }

    return this.loadProject(destination);
  }

  public async build(input: BuildProjectInput): Promise<BuildProjectResult> {
    const project = await this.resolve({ filePath: input.filePath });
    if (!project) {
      throw new InputValidationError(
        `No AgentCore project found from ${resolve(input.filePath)}. Run this command inside a project containing agentcore/agentcore.json.`,
      );
    }
    if (project.targets.length === 0) {
      throw new InputValidationError(
        `No deployment targets configured in ${join(project.configDir, "aws-targets.json")}. Add at least one target before building.`,
      );
    }

    const backend = this.backend(project.managedBy);
    this.logger.debug(`building project "${project.name}" with ${backend.name}`);
    const backendResult = await backend.build(project, project.targets, input.onProgress);

    input.onProgress?.({ message: "Recording build manifest..." });
    const manifest: BuildManifest = {
      version: 1,
      projectName: project.name,
      backend: backend.name,
      cliVersion: PACKAGE_VERSION,
      inputFingerprint: await computeProjectFingerprint(project.root),
      builtAt: this.now().toISOString(),
      cloudAssemblyPath: backendResult.cloudAssemblyPath,
      targets: backendResult.targets,
    };

    const manifestPath = join(project.configDir, ".build", "manifest.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      ...manifest,
      manifestPath: relative(project.root, manifestPath).replaceAll("\\", "/"),
    };
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }

  private backend(managedBy: string): ProjectBuildBackend {
    if (managedBy !== "CDK") {
      throw new InputValidationError(
        `Project backend "${managedBy}" is not supported. Supported backends: CDK`,
      );
    }
    return new CdkProjectBackend({
      logger: this.logger,
      runner: this.runner,
      checkTool: this.checkTool,
    });
  }

  private async loadProject(root: string): Promise<Project> {
    const configDir = join(root, "agentcore");
    const spec = await this.readConfig(
      join(configDir, "agentcore.json"),
      ProjectSpecEnvelopeSchema,
    );
    const targets = await this.readConfig(
      join(configDir, "aws-targets.json"),
      DeploymentTargetsSchema,
    );

    return {
      name: spec.name,
      root,
      configDir,
      managedBy: spec.managedBy,
      targets,
    };
  }

  private async readConfig<T>(
    path: string,
    schema: {
      safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error };
    },
  ): Promise<T> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new InputValidationError(`Unable to read project configuration at ${path}`, {
        cause: error,
      });
    }

    const result = schema.safeParse(value);
    if (!result.success) {
      throw new InputValidationError(`Invalid project configuration at ${path}: ${result.error}`, {
        cause: result.error,
      });
    }
    return result.data;
  }
}
