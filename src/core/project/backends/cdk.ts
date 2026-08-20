import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectStateError } from "../../../errors/errors";
import type { Project, ProjectEvent } from "../../../handlers/project/types";
import { requireTool, runProcess, type ProcessRunner } from "../../../io";
import type { Logger } from "../../../logging";
import type { ProjectBackend } from "./types";

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
};

/** Builds projects through the CDK app scaffolded by `agentcore project create`. */
export class CdkBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;

  constructor(config: CdkBackendConfig) {
    this.logger = config.logger;
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    const cdkDir = join(project.rootPath, "agentcore", "cdk");

    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");

    yield { message: "Synthesizing CloudFormation templates" };
    await this.runner(["npm", "run", "cdk", "--", "synth", "--quiet"], {
      cwd: cdkDir,
      onOutput: (chunk) => this.logger.debug(chunk),
    });
  }
}
