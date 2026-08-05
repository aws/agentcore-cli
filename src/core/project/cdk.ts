import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { InputValidationError } from "../../errors";
import type { ProcessRunner } from "../../io";
import type { Logger } from "../../logging";
import type { DeploymentTarget, Project, ProjectProgressEvent } from "../../handlers/project/types";
import type { BackendBuildResult, ProjectBuildBackend } from "./backend";
import { CloudAssemblyManifestSchema } from "./schemas";

type CdkBackendConfig = {
  logger: Logger;
  runner: ProcessRunner;
  checkTool: (tool: string, installHint: string, probeArgs?: string[]) => Promise<void>;
};

function stackName(projectName: string, targetName: string): string {
  return `AgentCore-${projectName.replaceAll("_", "-")}-${targetName.replaceAll("_", "-")}`;
}

export class CdkProjectBackend implements ProjectBuildBackend {
  readonly name = "CDK";

  constructor(private readonly config: CdkBackendConfig) {}

  async build(
    project: Project,
    targets: DeploymentTarget[],
    onProgress?: (event: ProjectProgressEvent) => void,
  ): Promise<BackendBuildResult> {
    const cdkDirectory = join(project.configDir, "cdk");
    const packageJson = join(cdkDirectory, "package.json");
    if (!existsSync(packageJson)) {
      throw new InputValidationError(
        `CDK project not found at ${cdkDirectory}. Create or restore agentcore/cdk before building.`,
      );
    }

    await this.config.checkTool("npm", "Install Node.js: https://nodejs.org/");
    await this.config.checkTool("node", "Install Node.js: https://nodejs.org/");

    onProgress?.({ message: "Compiling CDK application..." });
    await this.run(["npm", "run", "build"], cdkDirectory);

    const assemblyDirectory = join(cdkDirectory, "cdk.out");
    await rm(assemblyDirectory, { recursive: true, force: true });
    await mkdir(assemblyDirectory, { recursive: true });

    onProgress?.({ message: "Validating project and synthesizing deployment artifacts..." });
    await this.run(
      [
        "node",
        join("node_modules", "aws-cdk", "bin", "cdk"),
        "synth",
        "--output",
        "cdk.out",
        "--quiet",
      ],
      cdkDirectory,
    );

    const manifestPath = join(assemblyDirectory, "manifest.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new InputValidationError(
        `CDK synthesis did not produce a readable cloud assembly at ${manifestPath}`,
        { cause: error },
      );
    }

    const parsed = CloudAssemblyManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new InputValidationError(`Invalid CDK cloud assembly manifest at ${manifestPath}`, {
        cause: parsed.error,
      });
    }

    const synthesizedStacks = new Set(
      Object.entries(parsed.data.artifacts)
        .filter(([, artifact]) => artifact.type === "aws:cloudformation:stack")
        .map(([artifactId, artifact]) => artifact.properties?.stackName ?? artifactId),
    );
    const buildTargets = targets.map((target) => ({
      ...target,
      stackName: stackName(project.name, target.name),
    }));

    const missing = buildTargets.filter((target) => !synthesizedStacks.has(target.stackName));
    if (missing.length > 0) {
      throw new InputValidationError(
        `CDK synthesis did not produce stacks for target(s): ${missing.map((target) => target.name).join(", ")}`,
      );
    }

    return {
      cloudAssemblyPath: this.relativeToProject(project.root, assemblyDirectory),
      targets: buildTargets,
    };
  }

  private relativeToProject(projectRoot: string, path: string): string {
    return isAbsolute(path) ? relative(projectRoot, path).replaceAll("\\", "/") : path;
  }

  private run(command: string[], cwd: string): Promise<void> {
    return this.config.runner(command, {
      cwd,
      onOutput: (chunk) => this.config.logger.debug(chunk),
    });
  }
}
