import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ProjectStateError } from "../../../errors";
import type {
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  ResolvedProjectResource,
} from "../../../handlers/project/types";
import {
  atomicWrite,
  createLineSplitter,
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import type { Logger } from "../../../logging";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { withOutputEvents } from "../events";
import type { TransactionSearchEnabler } from "./cdk";
import { readDeployedState, stackReferenceOf } from "./cdk/deployedState";
import { resolveAwsAccount, type AccountResolver } from "./cdk/environment";
import {
  createCdkCredentialResolver,
  type CdkCredentialProvider,
  type CdkCredentialResolver,
} from "./cdk/toolkit";
import { TerraformAssetPackager, type TerraformAssetBuilder } from "./terraform/assets";
import { declaredResources, TerraformCompiler } from "./terraform/compiler";
import { TerraformState } from "./terraform/state";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
  ResolveProjectResourcesBackendInput,
} from "./types";

export type TerraformBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  resolveCredentials?: CdkCredentialResolver;
  resolveAccount?: AccountResolver;
  packageAssets?: TerraformAssetBuilder;
  enableTransactionSearch?: TransactionSearchEnabler;
};

/** Experimental backend: Terraform owns all resources and keeps local state per deployment target. */
export class TerraformBackend implements ProjectBackend {
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly packageAssets: TerraformAssetBuilder;
  private readonly compiler = new TerraformCompiler();

  constructor(private readonly config: TerraformBackendConfig) {
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    const packager = new TerraformAssetPackager(this.runner, this.checkTool);
    this.packageAssets = config.packageAssets ?? packager.build.bind(packager);
  }

  async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    this.compiler.preflight(project);
    await this.checkTool(
      "terraform",
      "Install Terraform: https://developer.hashicorp.com/terraform/install",
    );
    const state = new TerraformState(project, "build");
    const unlock = await state.lock();
    try {
      yield {
        type: "step",
        message: "Building Terraform configuration for validation (placeholder account and region)",
      };
      yield* this.generate(
        project,
        {
          name: "build",
          account: "000000000000",
          region: "us-west-2",
        },
        state,
      );
      const env = this.environment(state);
      yield* this.execute(["init", "-backend=false", "-input=false", "-no-color"], state, env);
      yield* this.execute(["validate", "-no-color"], state, env);
    } finally {
      await unlock();
    }
  }

  async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    this.compiler.preflight(project);
    const cdkState = await readDeployedState(this.json, project.rootPath);
    if (Object.values(cdkState.targets).some((target) => stackReferenceOf(target))) {
      throw new ProjectStateError(
        "The Terraform PoC supports new projects only. This project has a recorded CDK deployment; automatic migration or adoption is not supported.",
      );
    }
    await this.checkTool(
      "terraform",
      "Install Terraform: https://developer.hashicorp.com/terraform/install",
    );
    const { target } = input;
    const state = new TerraformState(project, target);
    const unlock = await state.lock();
    try {
      const tearingDown =
        declaredResources(project).length === 0 && (await state.hasManagedResources());
      if (tearingDown) {
        const approved = await input.confirmTeardown({
          projectName: project.name,
          targetName: target.name,
          account: target.account,
          region: target.region,
          resourceDescription: "all Terraform-managed resources for this target",
        });
        if (!approved) throw new ProjectStateError("Terraform teardown was cancelled.");
      }
      yield { type: "step", message: "Packaging assets and generating Terraform configuration" };
      yield* this.generate(project, target, state);
      const credentials = await this.credentialsForTarget(target);
      const env = this.environment(state, target, await credentials());
      yield { type: "step", message: "Initializing and validating Terraform" };
      yield* this.execute(["init", "-input=false", "-no-color"], state, env);
      yield* this.execute(["validate", "-no-color"], state, env);
      yield { type: "step", message: "Planning Terraform deployment" };
      // Never reuse a plan from a prior operation, particularly after a failed apply.
      const plan = "deployment.tfplan";
      await rm(join(state.directory, plan), { force: true });
      yield* this.execute(
        ["plan", "-input=false", "-no-color", "-lock-timeout=60s", `-out=${plan}`],
        state,
        env,
      );
      if (
        declaredResources(project).length > 0 &&
        input.transactionSearch !== false &&
        this.config.enableTransactionSearch
      ) {
        yield { type: "step", message: "Enabling CloudWatch Transaction Search" };
        try {
          await this.config.enableTransactionSearch(target, credentials);
        } catch (error) {
          yield {
            type: "warning",
            message: `Could not enable CloudWatch Transaction Search: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      yield {
        type: "step",
        message: tearingDown ? "Removing Terraform resources" : "Applying Terraform plan",
      };
      yield* this.execute(
        ["apply", "-input=false", "-no-color", "-lock-timeout=60s", plan],
        state,
        this.environment(state, target, await credentials()),
      );
      const outputs = await state.outputs();
      return {
        outputs: Object.fromEntries(
          Object.entries(outputs).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ...(tearingDown ? { tornDown: true } : {}),
      };
    } finally {
      // Keep assets, provider lock, plan, and state after failure for retry/cleanup.
      await unlock();
    }
  }

  async resolveDeployedResources(
    project: Project,
    { target }: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const resources = await new TerraformState(project, target).resources();
    if (resources.length === 0) {
      throw new ProjectStateError(
        `Project '${project.name}' has no Terraform deployment outputs for target '${target.name}'. ` +
          `Run 'agentcore deploy --target ${target.name}' first.`,
      );
    }
    const declared = new Set(
      declaredResources(project).map((resource) => `${resource.resourceType}/${resource.name}`),
    );
    const credentialProvider = await this.credentialsForTarget(target);
    return resources.flatMap((resource) =>
      (resource.resourceType === "runtime" || resource.resourceType === "gateway") &&
      declared.has(`${resource.resourceType}/${resource.name}`)
        ? [
            {
              resourceType: resource.resourceType,
              name: resource.name,
              id: resource.id,
              target,
              credentialProvider,
            },
          ]
        : [],
    );
  }

  async resolveProjectResources(
    project: Project,
    { target }: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    const resources = await new TerraformState(project, target).resources();
    const declarations = declaredResources(project);
    const resolve = (resource: (typeof declarations)[number]): ResolvedProjectResource => {
      const deployed = resources.find(
        (entry) =>
          entry.resourceType === resource.resourceType &&
          entry.name === resource.name &&
          entry.parentName === resource.parentName,
      );
      const children = declarations
        .filter(
          (entry) =>
            entry.parentName === resource.name &&
            ((entry.resourceType === "policy" && resource.resourceType === "policy-engine") ||
              (entry.resourceType === "gateway-target" && resource.resourceType === "gateway")),
        )
        .map(resolve);
      return {
        resourceType: resource.resourceType,
        name: resource.name,
        ...(children.length ? { children } : {}),
        ...(deployed
          ? {
              deploymentState: "deployed" as const,
              ...(deployed.arn ? { arn: deployed.arn } : { id: deployed.id }),
            }
          : { deploymentState: "local-only" as const }),
      };
    };
    return declarations.filter((resource) => !resource.parentName).map(resolve);
  }

  private async *generate(project: Project, target: AwsDeploymentTarget, state: TerraformState) {
    const assets = yield* withOutputEvents((emit) =>
      this.packageAssets(project, state.directory, emit),
    );
    const configuration = this.compiler.compile(project, target, assets);
    await atomicWrite(
      join(state.directory, "main.tf.json"),
      `${JSON.stringify(configuration, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async *execute(args: string[], state: TerraformState, env: NodeJS.ProcessEnv) {
    yield* withOutputEvents((emit) => {
      const lines = createLineSplitter(emit);
      return this.runner(["terraform", ...args], {
        cwd: state.directory,
        env,
        onOutput: (chunk) => lines.push(chunk),
      }).finally(() => lines.flush());
    });
  }

  private async credentialsForTarget(target: AwsDeploymentTarget): Promise<CdkCredentialProvider> {
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, but the active credentials belong to ${account}.`,
      );
    }
    return credentials;
  }

  private environment(
    state: TerraformState,
    target?: AwsDeploymentTarget,
    credentials?: Awaited<ReturnType<CdkCredentialProvider>>,
  ): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("TF_CLI_ARGS") || key.startsWith("TF_VAR_")) delete env[key];
    }
    if (credentials && target) {
      for (const key of [
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
        "AWS_ROLE_SESSION_NAME",
        "AWS_SECURITY_TOKEN",
      ])
        delete env[key];
      env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
      if (credentials.sessionToken) env.AWS_SESSION_TOKEN = credentials.sessionToken;
      else delete env.AWS_SESSION_TOKEN;
      env.AWS_REGION = target.region;
      env.AWS_DEFAULT_REGION = target.region;
    }
    return {
      ...env,
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      TF_DATA_DIR: join(state.directory, ".terraform"),
      TF_WORKSPACE: "default",
    };
  }
}
