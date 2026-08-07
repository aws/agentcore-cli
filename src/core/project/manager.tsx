import { existsSync } from "node:fs";
import { join } from "node:path";
import z from "zod";
import type {
  BuildProjectInput,
  CreateProjectInput,
  DeployProjectInput,
  ResolveProjectInput,
  Project,
  ProjectManager,
  ProjectEvent,
} from "../../handlers/project/types";
import type { Logger } from "../../logging";
import {
  atomicWrite,
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
} from "../../io";
import { defaultSource, type AssetSource } from "./source";
import { createProjectTreeFromTemplate, TEMPLATES } from "./templates";
import { enclosingProjectRoot } from "./fsUtils";
import { DeserializationError, ProjectStateError } from "../../errors/errors";

/** Resolves the AWS account ID of the active credentials (STS GetCallerIdentity). */
export type ResolveAwsAccount = (region: string) => Promise<string>;

type ProjectManagerConfig = {
  logger: Logger;
  source?: AssetSource; // Bun executable or dist/assets depending on runtime
  runner?: ProcessRunner; // injectable so tests never spawn real processes
  checkTool?: typeof requireTool; // injectable so tests don't depend on the host's PATH
  resolveAccount?: ResolveAwsAccount; // injectable so tests never call STS
};

// The subset of agentcore.json the manager reads; the CDK app validates the rest.
const projectSpecSchema = z.object({ name: z.string() });

// Mirrors AwsDeploymentTarget in @aws/agentcore-cdk: each entry names an
// account/region pair the CDK app synthesizes a stack for.
const awsTargetsSchema = z.array(
  z.object({ name: z.string(), account: z.string(), region: z.string() }),
);

type AwsTarget = z.infer<typeof awsTargetsSchema>[number];

const TARGETS_EXAMPLE = `[{ "name": "default", "account": "111122223333", "region": "us-east-1" }]`;

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly source: AssetSource;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly resolveAccount: ResolveAwsAccount | undefined;
  private readonly json: FsReadWriteJson;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.source = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.resolveAccount = config.resolveAccount;
    this.json = new FsReadWriteJson({ logger: config.logger });
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const root = enclosingProjectRoot(input.filePath);
    if (!root) return undefined;
    const spec = await this.json.read(join(root, "agentcore", "agentcore.json"), projectSpecSchema);
    return { name: spec.name, root };
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

    return { name: input.name, root: destination };
  }

  public async *build(input: BuildProjectInput): AsyncGenerator<ProjectEvent, Project> {
    const project = await this.resolve({ filePath: input.path });
    if (!project) {
      throw new ProjectStateError(
        `No AgentCore project found at ${input.path} or any parent directory ` +
          `(looked for agentcore/agentcore.json). Run 'agentcore project create' to scaffold one.`,
      );
    }

    yield* this.ensureDeploymentTargets(project.root, input.region);

    // The vended cdk.json runs the compiled app (node dist/bin/cdk.js), so the
    // TypeScript must be compiled before any CDK command works. cwd must be
    // agentcore/cdk: bin/cdk.ts resolves the config root as its parent.
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
    await this.checkTool("npx", "Install Node.js: https://nodejs.org/");
    const cdkDir = join(project.root, "agentcore", "cdk");
    const env = { AWS_REGION: input.region, AWS_DEFAULT_REGION: input.region };

    yield { message: "Compiling the CDK app" };
    yield* this.runStreaming(["npm", "run", "build"], cdkDir);

    yield { message: "Synthesizing CloudFormation templates with cdk synth" };
    yield* this.runStreaming(["npx", "cdk", "synth"], cdkDir, env);

    return project;
  }

  public async *deploy(input: DeployProjectInput): AsyncGenerator<ProjectEvent> {
    const project = yield* this.build(input);

    const cdkDir = join(project.root, "agentcore", "cdk");
    const env = { AWS_REGION: input.region, AWS_DEFAULT_REGION: input.region };

    if (!input.skipBootstrap) {
      // cdk bootstrap is idempotent and no-ops quickly on a current environment,
      // so it runs on every deploy rather than probing CloudFormation first.
      // --bootstrap-customer-key provisions a customer-managed KMS key for the
      // staging bucket, matching the original CLI's bootstrap parameters.
      const targets = await this.readDeploymentTargets(project.root);
      const environments = [
        ...new Set(targets.map((target) => `aws://${target.account}/${target.region}`)),
      ];
      for (const environment of environments) {
        yield { message: `Bootstrapping ${environment} with cdk bootstrap` };
        yield* this.runStreaming(
          ["npx", "cdk", "bootstrap", environment, "--bootstrap-customer-key"],
          cdkDir,
          env,
        );
      }
    }

    // The subprocess has no stdin, so a security-change approval prompt would
    // hang forever rather than fail; never ask.
    yield { message: "Deploying stacks with cdk deploy" };
    yield* this.runStreaming(
      ["npx", "cdk", "deploy", "--all", "--require-approval", "never"],
      cdkDir,
      env,
    );

    return project;
  }

  // Guarantees aws-targets.json names at least one deployment target: a missing
  // or empty file (what `create` scaffolds) is filled with a single `default`
  // target detected from the active credentials and the resolved region.
  // Existing targets are left alone; a file that exists but fails to parse is an
  // error to surface, never something to overwrite.
  private async *ensureDeploymentTargets(
    projectRoot: string,
    region: string,
  ): AsyncGenerator<ProjectEvent> {
    const targets = await this.readDeploymentTargets(projectRoot);
    if (targets.length > 0) return;

    yield { message: "Detecting the AWS account for a default deployment target" };
    let account: string;
    try {
      if (!this.resolveAccount) throw new Error("no account resolver is configured");
      account = await this.resolveAccount(region);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ProjectStateError(
        `No deployment targets are configured and the AWS account could not be detected ` +
          `(${reason}). Add a target to ${join(projectRoot, "agentcore", "aws-targets.json")} ` +
          `yourself, e.g.:\n\n${TARGETS_EXAMPLE}`,
        { cause },
      );
    }

    const target: AwsTarget = { name: "default", account, region };
    await atomicWrite(this.targetsPath(projectRoot), `${JSON.stringify([target], null, 2)}\n`);
    yield { message: `Configured default deployment target aws://${account}/${region}` };
  }

  // Reads aws-targets.json, treating a missing file as empty and surfacing a
  // parse failure as an actionable error naming the file.
  private async readDeploymentTargets(projectRoot: string): Promise<AwsTarget[]> {
    const path = this.targetsPath(projectRoot);
    if (!existsSync(path)) return [];
    try {
      return await this.json.read(path, awsTargetsSchema);
    } catch (cause) {
      if (!(cause instanceof DeserializationError)) throw cause;
      throw new ProjectStateError(
        `${path} exists but is not a valid deployment target list. ` +
          `Fix it or delete it to have a default target detected, e.g.:\n\n${TARGETS_EXAMPLE}`,
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

  // Runs a command, yielding each chunk of its output as a ProjectEvent as it
  // streams (and logging it), so callers see subprocess progress live. The
  // runner's onOutput callback feeds a queue the generator drains; a failure
  // (ProcessFailedError) propagates once the queued output has been yielded.
  private async *runStreaming(
    command: string[],
    cwd: string,
    env?: Record<string, string>,
  ): AsyncGenerator<ProjectEvent> {
    const queue: string[] = [];
    let wake = () => {};
    let settled = false;
    let failure: unknown;

    this.runner(command, {
      cwd,
      env,
      onOutput: (chunk) => {
        this.logger.debug(chunk);
        queue.push(chunk);
        wake();
      },
    })
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
        wake();
      });

    while (!settled || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield { subprocessOutput: queue.shift()! };
    }
    if (failure) throw failure;
  }
}
