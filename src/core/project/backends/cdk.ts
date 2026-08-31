import { existsSync } from "node:fs";
import { join } from "node:path";
import { MalformedServiceResponseError, ProjectStateError } from "../../../errors/errors";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import type { Logger } from "../../../logging";
import type { DeployBackendInput, ProjectBackend } from "./types";
import { createCloudFormationClient } from "../../factories";
import type { CreateCloudFormationClient } from "../../types";
import {
  createCredentialProvisioner,
  type CredentialProviderCalls,
  type CredentialProvisioner,
} from "./cdk/credentials";
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
  probeStack,
  resolveAwsAccount,
  type AccountResolver,
  type BootstrapProbe,
  type StackProbe,
} from "./cdk/environment";
import {
  createCdkCredentialResolver,
  createCdkRunner,
  loadBootstrapTemplate,
  type BootstrapTemplateLoader,
  type CdkCredentialResolver,
  type CdkRunner,
  type CdkRunOptions,
} from "./cdk/toolkit";

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  createCloudFormationClient?: CreateCloudFormationClient;
  /** Identity client used to provision the project's credential providers. */
  identity: CredentialProviderCalls;
  cdk?: CdkRunner;
  resolveCredentials?: CdkCredentialResolver;
  bootstrap?: BootstrapProbe;
  stack?: StackProbe;
  resolveAccount?: AccountResolver;
  loadBootstrapTemplate?: BootstrapTemplateLoader;
  provisionCredentials?: CredentialProvisioner;
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
  private readonly stack: StackProbe;
  private readonly resolveAccount: AccountResolver;
  private readonly loadBootstrapTemplate: BootstrapTemplateLoader;
  private readonly provisionCredentials: CredentialProvisioner;

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
    this.stack =
      config.stack ??
      ((stackName, region, credentials) => probeStack(stackName, region, credentials, readStack));
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.loadBootstrapTemplate = config.loadBootstrapTemplate ?? loadBootstrapTemplate;
    this.provisionCredentials =
      config.provisionCredentials ?? createCredentialProvisioner(config.identity);
  }

  // Local prerequisites for synth. Checked before any AWS mutation so a missing
  // toolchain or dependencies fails without having provisioned credentials.
  private async ensureCdkDependencies(project: Project): Promise<void> {
    const cdkDir = this.cdkDirectory(project);
    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    await this.ensureCdkDependencies(project);

    yield { message: "Synthesizing CloudFormation templates" };
    await this.runner(
      ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", this.assemblyDirectory(project)],
      {
        cwd: this.cdkDirectory(project),
        onOutput: (chunk) => this.logger.debug(chunk),
      },
    );
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { message: `Verifying AWS account ${target.account}` };
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }

    // Fail on local setup errors (missing toolchain/deps) and malformed state
    // before any AWS mutation, so a local problem never leaves credentials
    // provisioned or the stack ARN unrecorded.
    await this.ensureCdkDependencies(project);
    await readDeployedState(this.json, project.rootPath);

    // Credential providers aren't stack resources; the synthesized app reads their
    // ARNs from deployed-state.json, so they must exist and be recorded before synth.
    const provisioned = yield* this.provisionCredentials(project, {
      credentials,
      region: target.region,
    });
    // Recorded every deploy (even when empty) so dropping the last credential
    // from the spec clears the stale entry instead of leaving it advertised.
    await updateTargetState(this.json, project.rootPath, target.name, {
      resources: { credentials: provisioned },
    });

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
      yield { message: `Bootstrapping ${environment}` };
      const template = await this.loadBootstrapTemplate();
      try {
        await this.cdk(
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

    yield { message: `Deploying ${artifact.id}` };
    const { outputs, stackArn } = await this.cdk(
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
    if (!(await this.stack(artifact.stackName, target.region, options.credentials))) {
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

    yield { message: `Removing stack ${artifact.stackName}` };
    await this.cdk({ kind: "destroy", stackArtifactId: artifact.id }, options);
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  private cdkDirectory(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk");
  }

  private assemblyDirectory(project: Project): string {
    return join(this.cdkDirectory(project), "cdk.out");
  }
}
