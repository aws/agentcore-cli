import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateProjectInput,
  DeployProjectOptions,
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
  runCdk,
  runProcess,
  type CdkEvent,
  type CdkOperation,
  type CdkRunner,
  type CdkRunOptions,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../io";
import { stackForTarget } from "./assembly";
import { defaultSource, type AssetSource } from "./source";
import { createProjectTreeFromTemplate, TEMPLATES } from "./templates";
import { ProjectSpecSchema } from "../../projectSchemas/project";
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

// How the CDK toolkit's message levels land in the log. Its `result` reports an
// operation's outcome rather than a severity, and nothing this CLI logs is finer
// than debug, so `trace` joins it there.
const CDK_LOG_LEVELS: Record<CdkEvent["level"], "debug" | "info" | "warn" | "error"> = {
  error: "error",
  warn: "warn",
  info: "info",
  result: "info",
  debug: "debug",
  trace: "debug",
};

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  cdk?: CdkRunner; // injectable so tests never reach AWS
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
  private readonly cdk: CdkRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.cdk = config.cdk ?? runCdk;
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
    // Scaffold into a fresh directory, refusing to nest inside an existing project.
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

  // eslint-disable-next-line require-yield
  public async *addResource<TResource extends ProjectResource>(
    _project: Project,
    _resourceType: TResource,
    _resourceConfig: ProjectResourceConfig<TResource>,
  ): AsyncGenerator<ProjectEvent, Project> {
    throw new NotImplementedError("FsProjectManager.addResource is not yet implemented");
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    // agentcore.json records which backend owns the project's artifacts. CDK is the
    // only one today; a terraform or no-IaC backend adds an arm here rather than
    // editing the CDK path.
    switch (project.managedBy) {
      case "CDK":
        yield* this.buildWithCdk(project);
        break;
      default: {
        // Exhaustiveness: a new ManagedBy member fails to compile until it is handled.
        const unsupported: never = project.managedBy;
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
    // --output is passed explicitly rather than left to cdk.json, because deploy
    // reads this directory back. A project that sets cdk.json's `output` would
    // otherwise send synth somewhere deploy never looks, and deploy would ship
    // whatever stale assembly it found there while reporting success.
    yield { kind: "step", message: "Synthesizing CloudFormation templates" };
    await this.run(
      ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", this.assemblyPath(project)],
      cdkDir,
    );
  }

  // Where build writes the synthesized assembly and deploy reads it from. Both go
  // through here so the two can never disagree about the location.
  private assemblyPath(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk", "cdk.out");
  }

  public async *deploy(
    project: Project,
    options: DeployProjectOptions,
  ): AsyncGenerator<ProjectEvent, void> {
    // Dispatched the same way build is: the backend that owns the artifacts owns
    // how they reach AWS.
    switch (project.managedBy) {
      case "CDK":
        yield* this.deployWithCdk(project, options);
        break;
      default: {
        // Exhaustiveness: a new ManagedBy member fails to compile until it is handled.
        const unsupported: never = project.managedBy;
        throw new ProjectStateError(
          `project '${project.name}' declares an unsupported backend: ${String(unsupported)}`,
        );
      }
    }
  }

  // Synthesizes, bootstraps the target's environment, then deploys its stack.
  private async *deployWithCdk(
    project: Project,
    options: DeployProjectOptions,
  ): AsyncGenerator<ProjectEvent, void> {
    // Every stack's environment comes from aws-targets.json, so an empty list means
    // there is nowhere to deploy. Resolving an account from the active credentials
    // would let deploy guess where the user's infrastructure belongs; name the file
    // to fix instead, which also keeps deploy from depending on a working STS call.
    //
    // Read before synthesizing: the generated CDK app refuses to synth an empty
    // list too, so checking first replaces its message with one naming the file to
    // edit, and skips a synth that could not have produced anything deployable.
    const targets = await this.readDeploymentTargets(project.rootPath);
    if (targets.length === 0) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Add at least one to ${this.targetsPath(project.rootPath)}, e.g.:\n\n${TARGETS_EXAMPLE}`,
      );
    }

    // One deploy ships one target, so a project with a staging and a prod target
    // cannot reach prod by accident. Resolved before synthesizing so a misspelled
    // --target costs nothing, and because bootstrap needs the target's environment.
    const target = targets.find((candidate) => candidate.name === options.target);
    if (!target) {
      throw new ProjectStateError(
        `Project '${project.name}' has no deployment target named '${options.target}'. ` +
          `${this.targetsPath(project.rootPath)} defines: ${targets
            .map((candidate) => candidate.name)
            .join(", ")}.`,
      );
    }

    // Deploying exactly what was just synthesized keeps the two from drifting, and
    // build's dependency check runs before anything touches AWS.
    yield* this.buildWithCdk(project);

    // build synthesized into cdk.out; deploy reads that assembly rather than
    // re-synthesizing, so what reaches AWS is exactly what was synthesized.
    const run = {
      assemblyDirectory: this.assemblyPath(project),
      region: options.region,
    };

    // Resolved before bootstrapping so an assembly without a stack for this target
    // fails immediately rather than after minutes of bootstrapping.
    const stackName = await stackForTarget(this.json, run.assemblyDirectory, target.name);

    if (!options.skipBootstrap) {
      // Bootstrap is idempotent and no-ops quickly on an already-current
      // environment, so it runs every deploy rather than probing CloudFormation
      // first.
      const environment = `aws://${target.account}/${target.region}`;
      yield { kind: "step", message: `Bootstrapping ${environment}` };
      await this.runCdkOperation({ kind: "bootstrap", environments: [environment] }, run);
    }

    yield { kind: "step", message: `Deploying ${stackName}` };
    await this.runCdkOperation({ kind: "deploy", stackName }, run);
  }

  // Drives a CDK operation, recording everything it reports in the log file.
  //
  // The toolkit narrates a deploy in hundreds of lines, so none of it reaches the
  // screen: the steps above are what a deploy shows, and the command points at the
  // log for the detail. Each message keeps the toolkit's own severity, so a failure
  // reads as an error in the log rather than as one debug line among thousands.
  private async runCdkOperation(operation: CdkOperation, options: CdkRunOptions): Promise<void> {
    const logger = this.logger.child({ cdk: operation.kind });
    for await (const event of this.cdk(operation, options)) {
      logger[CDK_LOG_LEVELS[event.level]](event.message);
    }
  }

  // Reads aws-targets.json, treating a missing file as empty and surfacing a parse
  // failure as an actionable error that names the file rather than a Zod dump.
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
