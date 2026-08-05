import { join, relative } from "node:path";
import { AgentCoreCLIError, InputValidationError } from "../../errors";
import type { LocalFileSystem, ProcessRunner, ToolChecker } from "../../io";
import type { Logger } from "../../logging";
import type { DeploymentTarget, Project, ProjectProgressEvent } from "../../handlers/project/types";
import type { BackendBuildResult, ProjectBuildBackend } from "./backend";
import { CloudAssemblyManifestSchema } from "./schemas";
import { toStackName } from "../../assets/cdk/lib/names";

type CdkBackendConfig = {
  logger: Logger;
  runner: ProcessRunner;
  checkTool: ToolChecker;
  fileSystem: LocalFileSystem;
};

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
    if (!(await this.config.fileSystem.exists(packageJson))) {
      throw new InputValidationError(
        `CDK project not found at ${cdkDirectory}. Create or restore agentcore/cdk before building.`,
      );
    }

    await this.config.checkTool("npm", "Install Node.js: https://nodejs.org/");
    await this.config.checkTool("node", "Install Node.js: https://nodejs.org/");

    onProgress?.({ message: "Compiling CDK application..." });
    await this.run(["npm", "run", "build"], cdkDirectory);

    const assemblyDirectory = join(cdkDirectory, "cdk.out");
    await this.config.fileSystem.remove(assemblyDirectory);
    await this.config.fileSystem.createDirectory(assemblyDirectory);

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
      manifest = JSON.parse(await this.config.fileSystem.readText(manifestPath));
    } catch (error) {
      throw new AgentCoreCLIError(
        `CDK synthesis did not produce a readable cloud assembly at ${manifestPath}`,
        { cause: error },
      );
    }

    const parsed = CloudAssemblyManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new AgentCoreCLIError(`Invalid CDK cloud assembly manifest at ${manifestPath}`, {
        cause: parsed.error,
      });
    }

    const synthesizedStacks = new Set(
      Object.entries(parsed.data.artifacts)
        .filter(([, artifact]) => artifact.type === "aws:cloudformation:stack")
        .map(([artifactId, artifact]) => artifact.properties?.stackName ?? artifactId),
    );
    const stacks = Object.fromEntries(
      targets.map((target) => [target.name, toStackName(project.name, target.name)]),
    );

    const missing = targets.filter((target) => !synthesizedStacks.has(stacks[target.name]!));
    if (missing.length > 0) {
      throw new AgentCoreCLIError(
        `CDK synthesis did not produce stacks for target(s): ${missing.map((target) => target.name).join(", ")}`,
      );
    }

    return {
      artifact: {
        type: "cdk-cloud-assembly",
        path: this.relativeToProject(project.root, assemblyDirectory),
        stacks,
      },
    };
  }

  private relativeToProject(projectRoot: string, path: string): string {
    return relative(projectRoot, path).replaceAll("\\", "/");
  }

  private run(command: string[], cwd: string): Promise<void> {
    return this.config.runner(command, {
      cwd,
      onOutput: (chunk) => this.config.logger.debug(chunk),
    });
  }
}
