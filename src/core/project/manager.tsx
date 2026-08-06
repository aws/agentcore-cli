import { dirname, join, resolve } from "node:path";
import type z from "zod";
import { InputValidationError, NestedProjectError } from "../../errors";
import type {
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import {
  FsReadWriteJson,
  nodePathInspector,
  requireTool,
  runProcess,
  type PathInspector,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../io";
import { projectTree } from "./compose";
import { defaultSource, type AssetSource } from "./source";
import { TEMPLATES } from "./templates";
import { writeTree } from "./tree";
import { DeploymentTargetsSchema, ProjectSpecEnvelopeSchema } from "./config";

/** Walks up from directory looking for the agentcore/agentcore.json project marker. */
async function enclosingProjectRoot(
  paths: PathInspector,
  directory: string,
): Promise<string | undefined> {
  for (let current = directory; ; current = dirname(current)) {
    if (await paths.exists(join(current, "agentcore", "agentcore.json"))) {
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
  json?: ReadWriteJson;
  paths?: PathInspector;
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: AssetSource;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly paths: PathInspector;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: this.logger });
    this.paths = config.paths ?? nodePathInspector;
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const candidate = resolve(input.filePath);
    const directory = (await this.paths.isFile(candidate)) ? dirname(candidate) : candidate;
    const root = await enclosingProjectRoot(this.paths, directory);
    if (!root) return undefined;

    return this.loadProject(root);
  }

  public async create(input: CreateProjectInput): Promise<Project> {
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
    const enclosing = await enclosingProjectRoot(this.paths, process.cwd());
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
      if (await this.paths.exists(join(appDir, "pyproject.toml"))) {
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

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
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

  private async readConfig<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    try {
      return await this.json.read(path, schema);
    } catch (error) {
      throw new InputValidationError(`Invalid project configuration at ${path}`, {
        cause: error,
      });
    }
  }
}
