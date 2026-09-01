import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { MalformedServiceResponseError, ProjectStateError } from "../../../errors/errors";
import type {
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
} from "../../../handlers/project/types";
import {
  createLineSplitter,
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import { withOutputEvents } from "../events";
import type { Logger } from "../../../logging";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
} from "./types";
import { createCloudFormationClient } from "../../factories";
import type { CreateCloudFormationClient } from "../../types";
import {
  countDeployableResources,
  stackArtifactForTarget,
  type StackArtifact,
} from "./cdk/assembly";
import { readDeployedState, removeTargetState, updateTargetState } from "./cdk/deployedState";
import {
  bootstrapStackReader,
  createCloudFormationStackReader,
  probeBootstrap,
  resolveAwsAccount,
  type AccountResolver,
  type BootstrapProbe,
} from "./cdk/environment";
import {
  createCdkCredentialResolver,
  createCdkRunner,
  loadBootstrapTemplate,
  type BootstrapTemplateLoader,
  type CdkCredentialResolver,
  type CdkOperation,
  type CdkRunner,
  type CdkRunOptions,
  type CdkRunResult,
} from "./cdk/toolkit";
import { describeStack } from "./cdk/stackReader";

type StackDescriber = typeof describeStack;

/**
 * How many trailing Toolkit lines an operation keeps for error context. Matches
 * the cap streamProcess uses for a failed subprocess's captured output.
 */
const MAX_ERROR_OUTPUT_LINES = 20;

function findDeployedResourceId(
  stack: Stack,
  input: Pick<ResolvedDeployedResource, "resourceType" | "name">,
): string | undefined {
  if (!stack.StackName) return undefined;
  const exportResourceName = input.name.replaceAll("_", "-");
  const exportName =
    input.resourceType === "runtime"
      ? `${stack.StackName}-${exportResourceName}-RuntimeId`
      : `${stack.StackName}-Harness-${exportResourceName}-Id`;
  return stack.Outputs?.find((output) => output.ExportName === exportName)?.OutputValue;
}

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  createCloudFormationClient?: CreateCloudFormationClient;
  cdk?: CdkRunner;
  resolveCredentials?: CdkCredentialResolver;
  bootstrap?: BootstrapProbe;
  resolveAccount?: AccountResolver;
  loadBootstrapTemplate?: BootstrapTemplateLoader;
  describeStack?: StackDescriber;
};

/** Builds and deploys projects through the scaffolded CDK app. */
export class CdkBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly cdk: CdkRunner;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly bootstrap: BootstrapProbe;
  private readonly resolveAccount: AccountResolver;
  private readonly loadBootstrapTemplate: BootstrapTemplateLoader;
  private readonly describeStack: StackDescriber;

  constructor(config: CdkBackendConfig) {
    this.logger = config.logger;
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.cdk = config.cdk ?? createCdkRunner(config.logger);
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    const readStack = createCloudFormationStackReader(
      config.createCloudFormationClient ?? createCloudFormationClient,
    );
    const readBootstrapStack = bootstrapStackReader(readStack);
    this.bootstrap =
      config.bootstrap ??
      ((region, credentials) => probeBootstrap(region, credentials, readBootstrapStack));
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.loadBootstrapTemplate = config.loadBootstrapTemplate ?? loadBootstrapTemplate;
    this.describeStack =
      config.describeStack ??
      ((region, credentials, stackName) =>
        describeStack(region, credentials, stackName, (name) =>
          readStack(name, region, credentials),
        ));
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    const cdkDir = this.cdkDirectory(project);

    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");

    yield { type: "step", message: "Synthesizing CloudFormation templates" };
    yield* withOutputEvents((emit) => {
      // Chunks still go to the debug log whole; the splitter reassembles them
      // into lines for the live progress tail.
      const lines = createLineSplitter(emit);
      return this.runner(
        [
          "npm",
          "run",
          "cdk",
          "--",
          "synth",
          "--quiet",
          "--output",
          this.assemblyDirectory(project),
        ],
        {
          cwd: cdkDir,
          onOutput: (chunk) => {
            this.logger.debug(chunk);
            lines.push(chunk);
          },
        },
      ).finally(() => lines.flush());
    });
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { type: "step", message: `Verifying AWS account ${target.account}` };
    const credentials = await this.credentialsForTarget(target);

    // Validate any existing deployed state before mutating AWS. A malformed file
    // must fail here — not after bootstrap/deploy — so we never leave AWS changed
    // with the new stack ARN unrecorded because the post-deploy write can't parse it.
    await readDeployedState(this.json, project.rootPath);

    yield* this.build(project);
    const assemblyDirectory = this.assemblyDirectory(project);
    const artifact = await stackArtifactForTarget(this.json, assemblyDirectory, target.name);
    const options = { assemblyDirectory, credentials, region: target.region };

    // Decided before the Toolkit is handed the assembly: it reads a template
    // with nothing in it as an instruction to delete the stack, and reports that
    // as an ordinary successful deploy.
    if ((await countDeployableResources(this.json, assemblyDirectory, artifact)) === 0) {
      return yield* this.teardown({ project, artifact, input, options });
    }

    const bootstrap = await this.bootstrap(target.region, credentials);
    this.logger
      .child({
        account: target.account,
        region: target.region,
        bootstrapState: bootstrap.kind,
        ...("version" in bootstrap && { bootstrapVersion: bootstrap.version }),
      })
      .debug("checked CDK bootstrap stack");

    if (bootstrap.kind !== "current") {
      const environment = `aws://${target.account}/${target.region}`;
      yield { type: "step", message: `Bootstrapping ${environment}` };
      const template = await this.loadBootstrapTemplate();
      try {
        yield* this.runCdk(
          {
            kind: "bootstrap",
            environments: [environment],
            ...(template && { templateFile: template.path }),
          },
          options,
        );
      } finally {
        await template?.cleanup();
      }
    }

    yield { type: "step", message: `Deploying ${artifact.id}` };
    const { outputs, stackArn } = yield* this.runCdk(
      { kind: "deploy", stackArtifactId: artifact.id },
      options,
    );

    // A successful deploy always has a stack ARN (CDK's DeployedStack requires
    // it). Its absence means a malformed result; fail loudly rather than return
    // success without recording the binding later commands need.
    if (!stackArn) {
      throw new MalformedServiceResponseError(
        `The CDK Toolkit reported a successful deploy of '${artifact.id}' without a stack ARN.`,
      );
    }

    // Persist the deployed stack's ARN so later commands read live resource state
    // from CloudFormation. Merged per target, so deploying one target never drops
    // another's recorded state.
    await updateTargetState(this.json, project.rootPath, target.name, { stackArn });

    return { outputs };
  }

  /**
   * Removes the target's stack, for a deploy of a project that declares nothing
   * to deploy.
   *
   * Destroying explicitly rather than letting the Toolkit infer it from an empty
   * template is what makes this reportable: `destroy` fails loudly if the stack
   * cannot be removed, where a deploy of an empty template succeeds either way.
   */
  private async *teardown({
    project,
    artifact,
    input,
    options,
  }: {
    project: Project;
    artifact: StackArtifact;
    input: DeployBackendInput;
    options: CdkRunOptions;
  }): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    if (!(await this.describeStack(target.region, options.credentials, artifact.stackName))) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, and no stack ` +
          `'${artifact.stackName}' exists in ${target.account}/${target.region} to remove. ` +
          `Add a resource — for example 'agentcore project add runtime' — before deploying.`,
      );
    }

    const confirmed = await input.confirmTeardown({
      projectName: project.name,
      targetName: target.name,
      resourceDescription: `stack '${artifact.stackName}' and every resource in it`,
      account: target.account,
      region: target.region,
    });
    if (!confirmed) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, so deploying to target ` +
          `'${target.name}' would delete stack '${artifact.stackName}' and every resource in ` +
          `it. Re-run with --yes to confirm, or restore the resources the project should have.`,
      );
    }

    yield { type: "step", message: `Removing stack ${artifact.stackName}` };
    yield* this.runCdk({ kind: "destroy", stackArtifactId: artifact.id }, options);
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  /**
   * Runs one Toolkit operation with its progress streamed as `output` events.
   * The trailing lines are also kept so a failure can carry them: the Toolkit's
   * errors are often terse ("Access Denied"), and the resource events it
   * reported just before failing are what make the error debuggable from the
   * terminal alone.
   */
  private async *runCdk(
    operation: CdkOperation,
    options: CdkRunOptions,
  ): AsyncGenerator<ProjectEvent, CdkRunResult> {
    const recent: string[] = [];
    try {
      return yield* withOutputEvents((emit) =>
        this.cdk(operation, {
          ...options,
          onOutput: (line) => {
            recent.push(line);
            if (recent.length > MAX_ERROR_OUTPUT_LINES) recent.shift();
            emit(line);
          },
        }),
      );
    } catch (error) {
      if (error instanceof Error && recent.length > 0) {
        error.message += `\n\nRecent output:\n${recent.join("\n")}`;
      }
      throw error;
    }
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const { target } = input;
    const deployedState = await readDeployedState(this.json, project.rootPath);
    const stackArn = deployedState.targets[target.name]?.stackArn;
    if (!stackArn) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }

    const credentials = await this.credentialsForTarget(target);
    const stack = await this.describeStack(target.region, credentials, stackArn);
    if (!stack) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }

    const resources = [
      ...project.spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
      ...project.spec.harnesses.map(({ name }) => ({ resourceType: "harness" as const, name })),
    ];
    return resources.flatMap((resource) => {
      const id = findDeployedResourceId(stack, resource);
      return id ? [{ ...resource, id, target }] : [];
    });
  }

  private async credentialsForTarget(target: AwsDeploymentTarget) {
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }
    return credentials;
  }

  private cdkDirectory(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk");
  }

  private assemblyDirectory(project: Project): string {
    return join(this.cdkDirectory(project), "cdk.out");
  }
}
