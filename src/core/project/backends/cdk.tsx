import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project, ProjectEvent, ProjectStep } from "../../../handlers/project/types";
import type { Logger } from "../../../logging";
import {
  FsReadWriteJson,
  isBootstrapCurrent,
  requireTool,
  runCdk,
  runProcess,
  type BootstrapProbe,
  type CdkEvent,
  type CdkOperation,
  type CdkOutputs,
  type CdkRunner,
  type CdkRunOptions,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import { ProjectStateError } from "../../../errors/errors";
import { stackForTarget } from "../assembly";
import type { BackendDeployInput, ProjectBackend } from "./types";

// `result` is an outcome rather than a severity, and the log has no level below debug.
const CDK_LOG_LEVELS: Record<CdkEvent["level"], "debug" | "info" | "warn" | "error"> = {
  error: "error",
  warn: "warn",
  info: "info",
  result: "info",
  debug: "debug",
  trace: "debug",
};

// The toolkit colours its output for the terminal it assumes it is writing to.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\x1b\[[0-9;]*[a-zA-Z]/g;

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  cdk?: CdkRunner; // injectable so tests never reach AWS
  bootstrapped?: BootstrapProbe; // injectable so tests never reach AWS
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
  json?: ReadWriteJson; // injectable so tests read fixtures instead of disk
};

/** Builds and deploys a project through the CDK app that `agentcore create` generates. */
export class CdkBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly runner: ProcessRunner;
  private readonly cdk: CdkRunner;
  private readonly bootstrapped: BootstrapProbe;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;

  constructor(config: CdkBackendConfig) {
    this.logger = config.logger;
    this.runner = config.runner ?? runProcess;
    this.cdk = config.cdk ?? runCdk;
    this.bootstrapped = config.bootstrapped ?? isBootstrapCurrent;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
  }

  public async *build(project: Project): AsyncGenerator<ProjectStep, void> {
    const cdkDir = this.cdkPath(project);

    // The generated CDK app is built from its own node_modules; without them the
    // failure would otherwise surface as an opaque "cdk: not found".
    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");

    // The generated package.json defines `cdk` as "npm run build && cdk", so this one
    // command compiles and then synthesizes. Synthesis needs no AWS credentials.
    //
    // Build deliberately does not require a deployment target. A freshly created
    // project has none, and building is how the user first typechecks their agent, so
    // the generated app synthesizes one environment-agnostic stack when the list is
    // empty. Only deploy needs a real target, and it checks for one itself.
    //
    // --output is explicit because deploy reads this directory back: a project that set
    // cdk.json's `output` would otherwise have deploy ship whatever it found here.
    yield { kind: "step", message: "Synthesizing CloudFormation templates" };
    await this.run(
      ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", this.assemblyPath(project)],
      cdkDir,
    );
  }

  public async *deploy(
    project: Project,
    input: BackendDeployInput,
  ): AsyncGenerator<ProjectEvent, void> {
    // Deploy ships the assembly build just synthesized, so the two cannot drift.
    yield* this.build(project);
    const run = {
      assemblyDirectory: this.assemblyPath(project),
      region: input.region,
    };

    // Resolved before bootstrapping so an assembly with no stack for this target fails
    // immediately rather than after minutes of bootstrapping.
    const stackName = await stackForTarget(this.json, run.assemblyDirectory, input.target.name);

    // Bootstrapping updates a CloudFormation stack every deploy in the account shares —
    // and the parameters we bootstrap with would put a customer-managed key on a staging
    // bucket that had none — so an environment somebody has already prepared is left alone.
    const environment = `aws://${input.target.account}/${input.target.region}`;
    const bootstrapped = await this.bootstrapped(input.target.region);
    // Logged because it decides whether the step below runs at all: a deploy that then
    // fails on the bootstrap it skipped is otherwise unexplainable from the log alone.
    this.logger.child({ environment, bootstrapped }).debug("checked bootstrap");
    if (!bootstrapped) {
      yield { kind: "step", message: `Bootstrapping ${environment}` };
      await this.runCdkOperation({ kind: "bootstrap", environments: [environment] }, run);
    }

    yield { kind: "step", message: `Deploying ${stackName}` };
    const outputs = await this.runCdkOperation({ kind: "deploy", stackName }, run);

    // The stack's outputs are the endpoints and ARNs the deploy just created, so they are
    // reported rather than left in the log. Withheld when the stack declares none, so
    // nothing above has to decide what an empty set of outputs looks like.
    if (Object.keys(outputs).length > 0) yield { kind: "outputs", outputs };
  }

  private cdkPath(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk");
  }

  // Shared by build and deploy so the two cannot disagree about where the assembly is.
  private assemblyPath(project: Project): string {
    return join(this.cdkPath(project), "cdk.out");
  }

  // The toolkit narrates a deploy in hundreds of lines, so all of it goes to the log at
  // the severity the toolkit gave it, and the steps above are what a deploy shows. What
  // the operation produced is its return value, which `for await` would discard, so the
  // messages are drained by hand.
  private async runCdkOperation(
    operation: CdkOperation,
    options: CdkRunOptions,
  ): Promise<CdkOutputs> {
    const logger = this.logger.child({ cdk: operation.kind });
    const events = this.cdk(operation, options);
    for (let next = await events.next(); ; next = await events.next()) {
      if (next.done) return next.value;
      // A level this build has no mapping for still gets logged: the toolkit is resolved
      // at the user's install rather than bundled, so a newer one can report a level that
      // did not exist when this was compiled, and a deploy must not die over a log line.
      const level = CDK_LOG_LEVELS[next.value.level] ?? "info";
      logger[level](next.value.message.replace(ANSI_ESCAPES, ""));
    }
  }

  // Runs a command with its output streamed to the file logger.
  private run(command: string[], cwd: string): Promise<void> {
    return this.runner(command, { cwd, onOutput: (chunk) => this.logger.debug(chunk) });
  }
}
