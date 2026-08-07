import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
  ProjectEvent,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import { requireTool, runProcess, type ProcessRunner } from "../../io";
import { defaultSource, type AssetSource } from "./source";
import { createProjectTreeFromTemplate, TEMPLATES } from "./templates";
import { enclosingProjectRoot } from "./fsUtils";
import { ProjectStateError } from "../../errors/errors";

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: AssetSource;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
  }

  public resolve(_input: ResolveProjectInput): Promise<Project> {
    throw new Error(`ProjectManager.resolve is not implemented yet`);
  }

  public async *create(input: CreateProjectInput): AsyncGenerator<ProjectEvent> {
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
    const enclosing = enclosingProjectRoot(process.cwd());
    if (enclosing) {
      throw new ProjectStateError(
        `You cannot create a project inside an existing project: ${enclosing}`,
      );
    }

    const destination = join(process.cwd(), input.name);
    this.logger.debug(`scaffolding project "${input.name}" from template "${input.template}"`);

    yield { message: "Creating project tree" };
    const tree = await createProjectTreeFromTemplate(input.name, input.template, this.source);
    await tree.write(destination);

    // A failed step leaves the scaffolded files in place; the error tells the
    // user how to rerun the step by hand.
    if (!input.skipInstall) {
      await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
      yield { message: "Installing CDK dependencies with npm" };
      await this.run(["npm", "install"], join(destination, "agentcore", "cdk"));

      const appDir = join(destination, "app", TEMPLATES[input.template].appDir);
      if (existsSync(join(appDir, "pyproject.toml"))) {
        await this.checkTool(
          "uv",
          "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
        );
        yield { message: "Syncing Python dependencies with uv" };
        await this.run(["uv", "sync"], appDir);
      }
    }

    if (!input.skipGit) {
      await this.checkTool("git", "Install git: https://git-scm.com/downloads");
      yield { message: "Initializing git repository" };
      await this.run(["git", "init"], destination);
    }

    return { name: input.name };
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}
