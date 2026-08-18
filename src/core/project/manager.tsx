import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  AddResourceInput,
  CreateProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
  ProjectEvent,
  ProjectResource,
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
import { createHarnessTreeFromSpec, createProjectTreeFromTemplate, TEMPLATES } from "./templates";
import { ProjectSpecSchema } from "../../projectSchemas/project";
import { enclosingProjectRoot } from "./fsUtils";
import {
  AgentCoreCLIError,
  DeserializationError,
  InputValidationError,
  NotImplementedError,
  ProjectStateError,
} from "../../errors/errors";
import type { HarnessSpecSchema } from "../../projectSchemas/harness";
import z from "zod";

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
  json?: ReadWriteJson; // injectable so tests read fixtures instead of disk
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
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
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
        spec,
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
    const agentCoreSpecPath = join(project.rootPath, "agentcore", "agentcore.json");
    const projectSpecKey = toProjectSpecKey(resourceType);

    yield { message: `Reading project spec file at '${agentCoreSpecPath}'` };
    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    const existingResources = existingProjectSpec[projectSpecKey];
    if (existingResources.find((r) => r.name === resourceConfig.name))
      throw new InputValidationError(
        `a ${resourceType} with name '${resourceConfig.name}' already exists`,
      );

    const newResources = [...existingResources];
    const scaffoldedPaths: string[] = [];

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
      // TODO: add limited special casing for runtime and default for other resources that proxy directly to spec changes.
    }

    yield { message: `Updating project spec file at '${agentCoreSpecPath}'` };

    const newSpec = { ...existingProjectSpec, [projectSpecKey]: newResources };
    const newSpecParseResult = ProjectSpecSchema.safeParse(newSpec);

    if (!newSpecParseResult.success)
      throw new InputValidationError(z.prettifyError(newSpecParseResult.error), {
        cause: newSpecParseResult.error,
      });

    // rollback scaffolding changes on failed config writes to prevent bad state.
    try {
      const newProjectSpec = await this.json.write(agentCoreSpecPath, newSpecParseResult.data);

      return {
        ...project,
        spec: newProjectSpec,
      };
    } catch (err) {
      this.logger.warn(
        `failed to update ${agentCoreSpecPath}; attempting best-effort cleanup of scaffolded files`,
      );
      await Promise.all(
        scaffoldedPaths.map((p) =>
          rm(p, { recursive: true, force: true }).catch((e) => {
            const error = AgentCoreCLIError.fromError(e);
            this.logger
              .child({ errorName: error.name, errorMessage: error.message })
              .warn(`failed to clean up ${p}`);
          }),
        ),
      );
      throw err;
    }
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
    // agentcore.json records which backend owns the project's artifacts. CDK is the
    // only one today; a terraform or no-IaC backend adds an arm here rather than
    // editing the CDK path.
    switch (project.spec.managedBy) {
      case "CDK":
        yield* this.buildWithCdk(project);
        break;
      default: {
        // Exhaustiveness: a new ManagedBy member fails to compile until it is handled.
        const unsupported: never = project.spec.managedBy;
        throw new ProjectStateError(
          `project '${project.name}' declares an unsupported backend: ${String(unsupported)}`,
        );
      }
    }
  }

  // Compiles the generated CDK app and synthesizes its CloudFormation templates.
  private async *buildWithCdk(project: Project): AsyncGenerator<ProjectEvent, void> {
    const cdkDir = join(project.rootPath, "agentcore", "cdk");

    // The generated CDK app is built from its own node_modules; without them the
    // failure would otherwise surface as an opaque "cdk: not found".
    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");

    // The generated package.json defines `cdk` as "npm run build && cdk", so this
    // single command compiles the app and then synthesizes it. Synthesis needs no
    // AWS credentials: each stack's environment comes from aws-targets.json.
    //
    // Build deliberately does not require a deployment target. A freshly created
    // project has none, and building is how the user first typechecks their agent, so
    // the generated app synthesizes one environment-agnostic stack when the list is
    // empty. Only deploying somewhere needs a real target.
    yield { message: "Synthesizing CloudFormation templates" };
    await this.run(["npm", "run", "cdk", "--", "synth", "--quiet"], cdkDir);
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
  }
}
