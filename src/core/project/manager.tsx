import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateProjectInput,
  DeployProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
  ProjectEvent,
  ProjectResource,
  ProjectResourceConfig,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../io";
import { CdkBackend } from "./backends/cdk";
import type { ProjectBackend } from "./backends/types";
import { defaultSource, type AssetSource } from "./source";
import { createProjectTreeFromTemplate, TEMPLATES } from "./templates";
import { ProjectSpecSchema, type ManagedBy } from "../../projectSchemas/project";
import { AwsTargetsSchema, type AwsTarget } from "../../projectSchemas/aws-targets";
import { enclosingProjectRoot } from "./fsUtils";
import {
  DeserializationError,
  InputValidationError,
  NotImplementedError,
  ProjectStateError,
} from "../../errors/errors";

// Shown when aws-targets.json names no usable target, so the fix is on screen.
const TARGETS_EXAMPLE = `[{ "name": "default", "account": "111122223333", "region": "us-east-1" }]`;

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
  json?: ReadWriteJson; // injectable so tests read fixtures instead of disk
  backends?: Partial<Record<ManagedBy, ProjectBackend>>; // injectable so tests never reach AWS
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
  private readonly backends: Partial<Record<ManagedBy, ProjectBackend>>;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.backends = config.backends ?? {
      CDK: new CdkBackend({
        logger: config.logger,
        runner: config.runner,
        checkTool: config.checkTool,
        json: config.json,
      }),
    };
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const rootPath = enclosingProjectRoot(input.filePath);
    if (!rootPath) return undefined;

    const configPath = join(rootPath, "agentcore", "agentcore.json");
    try {
      const spec = await this.json.read(configPath, ProjectSpecSchema);
      return {
        name: spec.name,
        rootPath,
        managedBy: spec.managedBy,
        runtimes: spec.runtimes,
      };
    } catch (error) {
      // A malformed agentcore.json is a user-correctable problem, not a crash.
      if (error instanceof DeserializationError) {
        throw new InputValidationError(`invalid project configuration at ${configPath}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async *create(input: CreateProjectInput): AsyncGenerator<ProjectEvent, Project> {
    const enclosing = enclosingProjectRoot(process.cwd());
    if (enclosing) {
      throw new ProjectStateError(
        `You cannot create a project inside an existing project: ${enclosing}`,
      );
    }

    const destination = join(process.cwd(), input.name);
    this.logger.debug(`scaffolding project "${input.name}" from template "${input.template}"`);

    yield { kind: "step", message: "Creating project tree" };
    const tree = await createProjectTreeFromTemplate(input.name, input.template, this.source);
    await tree.write(destination);

    // A failed step leaves the scaffolded files in place; the error tells the
    // user how to rerun the step by hand.
    if (!input.skipInstall) {
      await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
      yield { kind: "step", message: "Installing CDK dependencies with npm" };
      await this.run(["npm", "install"], join(destination, "agentcore", "cdk"));

      const appDir = join(destination, "app", TEMPLATES[input.template].appDir);
      if (existsSync(join(appDir, "pyproject.toml"))) {
        await this.checkTool(
          "uv",
          "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
        );
        yield { kind: "step", message: "Syncing Python dependencies with uv" };
        await this.run(["uv", "sync"], appDir);
      }
    }

    if (!input.skipGit) {
      await this.checkTool("git", "Install git: https://git-scm.com/downloads");
      yield { kind: "step", message: "Initializing git repository" };
      await this.run(["git", "init"], destination);
    }

    // Read back rather than restating the template's shape, so the returned runtimes
    // are schema-validated.
    const project = await this.resolve({ filePath: destination });
    if (!project) {
      throw new ProjectStateError(
        `the project scaffolded at ${destination} could not be read back`,
      );
    }
    return project;
  }

  // eslint-disable-next-line require-yield
  public async *addResource<TResource extends ProjectResource>(
    _project: Project,
    _resourceType: TResource,
    _resourceConfig: ProjectResourceConfig<TResource>,
  ): AsyncGenerator<ProjectEvent, Project> {
    throw new NotImplementedError("FsProjectManager.addResource is not yet implemented");
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    yield* this.backendFor(project).build(project);
  }

  public async *deploy(
    project: Project,
    input: DeployProjectInput,
  ): AsyncGenerator<ProjectEvent, void> {
    // aws-targets.json is the only source of a stack's account and region, so deploy
    // never has to resolve one from the active credentials. Read before building so an
    // unusable list is reported as the file to edit rather than as a build failure.
    const targets = await this.readDeploymentTargets(project.rootPath);
    if (targets.length === 0) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Add at least one to ${this.targetsPath(project.rootPath)}, e.g.:\n\n${TARGETS_EXAMPLE}`,
      );
    }

    // One deploy ships one target, so a project with staging and prod targets cannot
    // reach prod by accident. Resolved first so a misspelled --target costs nothing.
    const target = targets.find((candidate) => candidate.name === input.target);
    if (!target) {
      throw new ProjectStateError(
        `Project '${project.name}' has no deployment target named '${input.target}'. ` +
          `${this.targetsPath(project.rootPath)} defines: ${targets
            .map((candidate) => candidate.name)
            .join(", ")}.`,
      );
    }

    yield* this.backendFor(project).deploy(project, { target, region: input.region });
  }

  // agentcore.json records which tool owns the project's artifacts; a project declaring
  // one this build has no backend for is a configuration error, not a crash.
  private backendFor(project: Project): ProjectBackend {
    const backend = this.backends[project.managedBy];
    if (!backend) {
      throw new ProjectStateError(
        `project '${project.name}' declares an unsupported backend: ${project.managedBy}`,
      );
    }
    return backend;
  }

  // A missing file reads as empty; a malformed one names itself rather than dumping Zod.
  private async readDeploymentTargets(projectRoot: string): Promise<AwsTarget[]> {
    const path = this.targetsPath(projectRoot);
    if (!existsSync(path)) return [];
    try {
      return await this.json.read(path, AwsTargetsSchema);
    } catch (cause) {
      if (!(cause instanceof DeserializationError)) throw cause;
      throw new ProjectStateError(
        `${path} is not a valid list of deployment targets. Fix it, e.g.:\n\n${TARGETS_EXAMPLE}`,
        { cause },
      );
    }
  }

  private targetsPath(projectRoot: string): string {
    return join(projectRoot, "agentcore", "aws-targets.json");
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}
