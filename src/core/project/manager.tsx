import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import z from "zod";
import { DeserializationError, InvalidProjectConfigError, NestedProjectError } from "../../errors";
import {
  ProjectSpecSchema,
  type CreateProjectInput,
  type ResolveProjectInput,
  type Project,
  type ProjectManager,
} from "../../handlers/project/types";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import type { Logger } from "../../logging";
import { requireTool, runProcess, type ProcessRunner } from "../../io";
import { agentcoreSpec, projectTree } from "./compose";
import { defaultSource, type AssetSource } from "./source";
import { TEMPLATES } from "./templates";
import { writeTree } from "./tree";

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
  json?: ReadWriteJson;
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

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: this.logger });
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const rootPath = enclosingProjectRoot(input.filePath);
    if (!rootPath) {
      return undefined;
    }

    const configPath = join(rootPath, "agentcore", "agentcore.json");
    let spec;
    try {
      spec = await this.json.read(configPath, ProjectSpecSchema);
    } catch (e) {
      if (!(e instanceof DeserializationError)) throw e;
      const detail = e.cause instanceof z.ZodError ? z.prettifyError(e.cause) : "not valid JSON";
      throw new InvalidProjectConfigError(configPath, detail);
    }

    return { name: spec.name, rootPath, runtimes: spec.runtimes };
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

    const spec = agentcoreSpec(input.name, input.template);
    return { name: spec.name, rootPath: destination, runtimes: spec.runtimes };
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}
