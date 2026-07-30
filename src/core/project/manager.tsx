import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { NestedProjectError } from "../../errors";
import type {
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import { requireTool, runCommand, type CommandRunner } from "../../io";
import { projectTree } from "./compose";
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
  runner?: CommandRunner; // injectable so tests never spawn real processes
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: AssetSource;
  private readonly runner: CommandRunner;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runCommand;
  }

  public resolve(_input: ResolveProjectInput): Promise<Project> {
    throw new Error(`ProjectManager.resolve is not implemented yet`);
  }

  public async create(input: CreateProjectInput): Promise<Project> {
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
    const enclosing = enclosingProjectRoot(process.cwd());
    if (enclosing) {
      throw new NestedProjectError(enclosing);
    }
    const destination = join(process.cwd(), input.name);
    this.logger.debug(`scaffolding project "${input.name}" from template "${input.template}"`);

    input.onProgress?.("Scaffolding project files...");
    const tree = await projectTree(input.name, input.template, this.source);
    await writeTree(tree, destination);

    // A failed step leaves the scaffolded files in place; the error tells the
    // user how to rerun the step by hand.
    if (!input.skipInstall) {
      requireTool("npm", "Install Node.js: https://nodejs.org/");
      input.onProgress?.("Installing CDK dependencies (npm install)...");
      await this.run(["npm", "install"], join(destination, "agentcore", "cdk"));

      const appDir = join(destination, "app", TEMPLATES[input.template].appDir);
      if (existsSync(join(appDir, "pyproject.toml"))) {
        requireTool("uv", "Install uv: https://docs.astral.sh/uv/getting-started/installation/");
        input.onProgress?.("Syncing Python dependencies (uv sync)...");
        await this.run(["uv", "sync"], appDir);
      }
    }

    if (!input.skipGit) {
      requireTool("git", "Install git: https://git-scm.com/downloads");
      input.onProgress?.("Initializing git repository...");
      await this.run(["git", "init"], destination);
    }

    return { name: input.name };
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}
