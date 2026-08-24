import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  AddResourceInput,
  CreateProjectInput,
  DeployProjectInput,
  DeployResult,
  ResolveProjectInput,
  Project,
  ProjectManager,
  ProjectEvent,
  ProjectResource,
  RemoveResourceInput,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../io";
import { defaultSource, type AssetSource } from "./source";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "./envLocal";
import { createHarnessTreeFromSpec, createProjectTreeFromTemplate, TEMPLATES } from "./templates";
import { ProjectSpecSchema, type ManagedBy } from "../../projectSchemas/project";
import { enclosingProjectRoot } from "./fsUtils";
import {
  AgentCoreCLIError,
  InputValidationError,
  NotImplementedError,
  ProjectStateError,
} from "../../errors/errors";
import type { HarnessSpecSchema } from "../../projectSchemas/harness";
import z from "zod";
import { CdkBackend } from "./backends/cdk";
import type { ProjectBackend } from "./backends/types";
import { AwsDeploymentTargetsSchema } from "../../projectSchemas/aws-targets";

const TARGETS_EXAMPLE = '[{ "name": "default", "account": "111122223333", "region": "us-east-1" }]';

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
  json?: ReadWriteJson; // injectable so tests read fixtures instead of disk
  backends?: Partial<Record<ManagedBy, ProjectBackend>>;
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
      }),
    };
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const rootPath = enclosingProjectRoot(input.filePath);
    if (!rootPath) return undefined;

    const configPath = join(rootPath, "agentcore", "agentcore.json");
    const spec = await this.json.read(configPath, ProjectSpecSchema);
    return {
      name: spec.name,
      rootPath,
      spec,
    };
  }

  public async *create(input: CreateProjectInput): AsyncGenerator<ProjectEvent, Project> {
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

    // A created project is a resolvable one, so read it back rather than
    // duplicating the template's shape: the returned runtimes are then
    // schema-validated instead of the template's loosely-typed spec sections.
    const project = await this.resolve({ filePath: destination });
    if (!project) {
      throw new ProjectStateError(
        `the project scaffolded at ${destination} could not be read back`,
      );
    }
    return project;
  }

  public async *addResource(
    project: Project,
    input: AddResourceInput,
  ): AsyncGenerator<ProjectEvent, Project> {
    const { resourceType, resourceConfig } = input;
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const projectSpecKey = toProjectSpecKey(resourceType);

    yield { message: `Reading project spec file at '${agentCoreSpecPath}'` };
    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    const existingResources = existingProjectSpec[projectSpecKey];
    if (existingResources.find((r) => r.name === resourceConfig.name))
      throw new InputValidationError(
        `a ${resourceType} with name '${resourceConfig.name}' already exists`,
      );

    // Widened: arms push their own shapes; the whole-spec safeParse below validates.
    const newResources: unknown[] = [...existingResources];
    const scaffoldedPaths: string[] = [];
    // Non-file work that a failed spec write must also reverse.
    let envFile: EnvLocalFile | undefined;

    switch (resourceType) {
      case "harness": {
        yield { message: `Scaffolding harness in project` };
        const outputPath = join(project.rootPath, "app", resourceConfig.name);
        scaffoldedPaths.push(outputPath);
        const harnessPath = await this.scaffoldHarness(outputPath, input.resourceConfig);

        newResources.push({
          name: input.resourceConfig.name,
          path: relative(project.rootPath, harnessPath),
        });
        break;
      }
      case "runtime": {
        throw new NotImplementedError(
          "runtime case not yet implemented in FsProjectManager.addResource",
        );
      }
      case "credential": {
        // No file scaffolding; the secret placeholder is staged into .env.local
        // and reversed with the spec write if that commit fails.
        newResources.push(input.resourceConfig);
        if (input.envEntries?.length) {
          envFile = new EnvLocalFile(project.rootPath);
          yield { message: `Updating secrets file at '${envFile.path}'` };
          const { skipped } = await envFile.insertIfNew(input.envEntries);
          for (const key of skipped) {
            yield {
              message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
            };
          }
        }
        break;
      }
      case "config-bundle":
      case "online-eval":
      case "online-insight":
      case "memory":
        newResources.push(resourceConfig);
        break;

      default: {
        const unhandled: never = input;
        throw new NotImplementedError(`unsupported project resource: ${String(unhandled)}`);
      }
    }

    yield { message: `Updating project spec file at '${agentCoreSpecPath}'` };

    const newSpec = { ...existingProjectSpec, [projectSpecKey]: newResources };

    // Validate and write inside the same boundary so a rejected spec rolls back
    // staged side effects (.env.local, scaffolded files) rather than leaving them.
    let newProjectSpec: z.infer<typeof ProjectSpecSchema>;
    try {
      const newSpecParseResult = ProjectSpecSchema.safeParse(newSpec);
      if (!newSpecParseResult.success)
        throw new InputValidationError(z.prettifyError(newSpecParseResult.error), {
          cause: newSpecParseResult.error,
        });
      newProjectSpec = await this.json.write(agentCoreSpecPath, newSpecParseResult.data);
    } catch (err) {
      this.logger.warn(
        `could not commit the spec update to ${agentCoreSpecPath}; attempting best-effort cleanup of staged changes`,
      );
      await Promise.all([
        ...scaffoldedPaths.map((p) =>
          rm(p, { recursive: true, force: true }).catch((e) => {
            const error = AgentCoreCLIError.fromError(e);
            this.logger
              .child({ errorName: error.name, errorMessage: error.message })
              .warn(`failed to clean up ${p}`);
          }),
        ),
        envFile?.rollback().catch((e) => {
          const error = AgentCoreCLIError.fromError(e);
          this.logger
            .child({ errorName: error.name, errorMessage: error.message })
            .warn(`failed to roll back ${ENV_LOCAL_RELATIVE_PATH}`);
        }),
      ]);
      throw err;
    }

    return {
      ...project,
      spec: newProjectSpec,
    };
  }

  private getProjectSpecPath(project: Project): string {
    return join(project.rootPath, "agentcore", "agentcore.json");
  }

  public async removeResource(project: Project, input: RemoveResourceInput): Promise<Project> {
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const projectSpecKey = toProjectSpecKey(input.resourceType);

    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    const existingResources = existingProjectSpec[projectSpecKey];
    const newResources = existingResources.filter((r) => r.name !== input.name);

    if (newResources.length === existingResources.length)
      this.logger
        .child({ input })
        .warn(`unable to remove resource from project that does not exist.`);

    const newSpecParseResult = ProjectSpecSchema.safeParse({
      ...existingProjectSpec,
      [projectSpecKey]: newResources,
    });

    if (!newSpecParseResult.success)
      throw new InputValidationError(z.prettifyError(newSpecParseResult.error), {
        cause: newSpecParseResult.error,
      });

    const newProjectSpec = await this.json.write(agentCoreSpecPath, newSpecParseResult.data);

    return {
      ...project,
      spec: newProjectSpec,
    };
  }

  private async scaffoldHarness(
    outputPath: string,
    harnessSpec: z.input<typeof HarnessSpecSchema>,
  ): Promise<string> {
    const harness = await createHarnessTreeFromSpec({
      ...harnessSpec,
      dockerfile: harnessSpec.dockerfile ? "Dockerfile" : undefined,
    });

    if (harnessSpec.dockerfile) {
      if (!existsSync(harnessSpec.dockerfile))
        throw new InputValidationError(`dockerfile not found: '${harnessSpec.dockerfile}'`);
    }

    await harness.write(outputPath);

    if (harnessSpec.dockerfile) {
      await copyFile(harnessSpec.dockerfile, join(outputPath, "Dockerfile"));
    }
    return outputPath;
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    yield* this.backendFor(project).build(project);
  }

  // Resolves the named target from aws-targets.json before handing off, so the
  // backend receives a fully resolved account and region and never has to know
  // how targets are stored. The backend owns everything after that point.
  public async *deploy(
    project: Project,
    input: DeployProjectInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const targetsPath = join(project.rootPath, "agentcore", "aws-targets.json");
    if (!existsSync(targetsPath)) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Add ${targetsPath}, for example:\n\n${TARGETS_EXAMPLE}`,
      );
    }

    const targets = await this.json.read(targetsPath, AwsDeploymentTargetsSchema);

    if (targets.length === 0) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Add at least one to ${targetsPath}, for example:\n\n${TARGETS_EXAMPLE}`,
      );
    }

    const target = targets.find((candidate) => candidate.name === input.target);
    if (!target) {
      throw new ProjectStateError(
        `Project '${project.name}' has no deployment target named '${input.target}'. ` +
          `${targetsPath} defines: ${targets.map(({ name }) => name).join(", ")}.`,
      );
    }

    return yield* this.backendFor(project).deploy(project, { target });
  }

  private backendFor(project: Project): ProjectBackend {
    const backend = this.backends[project.spec.managedBy];
    if (!backend) {
      throw new ProjectStateError(
        `project '${project.name}' declares an unsupported backend: ${project.spec.managedBy}`,
      );
    }
    return backend;
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}

/** Map {@link ProjectResource} to keys in the project spec.
 * Note: we let TS infer the return type to avoid pulling in keys that do not correspond to resources (ex. name, managedBy, etc.)
 */
function toProjectSpecKey(resourceType: ProjectResource) {
  switch (resourceType) {
    case "harness":
      return "harnesses";
    case "runtime":
      return "runtimes";
    case "credential":
      return "credentials";
    case "config-bundle":
      return "configBundles";
    case "online-eval":
    case "online-insight":
      return "onlineEvalConfigs";
    case "memory":
      return "memories";
  }
}
