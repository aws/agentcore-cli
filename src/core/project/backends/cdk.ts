import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { MalformedServiceResponseError, ProjectStateError } from "../../../errors/errors";
import type {
  DeployableResource,
  DeployResult,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
} from "../../../handlers/project/types";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
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
  type CdkRunner,
  type CdkRunOptions,
} from "./cdk/toolkit";
import { describeStack } from "./cdk/stackReader";

type StackDescriber = typeof describeStack;

// Mirrors @aws/agentcore-cdk's exportName() (its src/cdk/logical-ids.ts): join the
// parts with "-" after turning "_" into "-" and dropping anything outside
// [A-Za-z0-9:-]. Replicated rather than imported because that package is a CDK
// construct library, not a CLI dependency — this is the source-of-truth format.
function cfnExportName(...parts: string[]): string {
  return parts.map((part) => part.replace(/_/g, "-").replace(/[^a-zA-Z0-9:-]/g, "")).join("-");
}

// toCdkId mirrors the payment CfnOutput logical-id construction in the CLI's own
// cdk-stack.ts (assets/cdk/lib/cdk-stack.ts): underscores stripped, rest kept.
function toCdkId(name: string): string {
  return name.replace(/_/g, "");
}

// The exportName parts (after the stack name) for every type whose deployed id is
// a CloudFormation export. credential + payment are excluded on purpose — credential
// comes from deployed-state, payment matches by OutputKey below. `satisfies Record`
// makes this exhaustive: adding a DeployableResource without a row here is a compile
// error, so a new type can never silently resolve to "not found".
type CfnOutputResource = Exclude<DeployableResource, "credential" | "payment">;

const EXPORT_PARTS = {
  runtime: (name) => [name, "RuntimeId"],
  harness: (name) => ["Harness", name, "Id"],
  memory: (name) => ["Memory", name, "Id"],
  "knowledge-base": (name) => ["KnowledgeBase", name, "Id"],
  evaluator: (name) => ["Evaluator", name, "Id"],
  "online-eval": (name) => ["OnlineEval", name, "Id"],
  gateway: (name) => ["Gateway", name, "Id"],
  "gateway-target": (name) => ["GatewayTarget", name, "Id"],
  "policy-engine": (name) => ["PolicyEngine", name, "Id"],
  policy: (name, parent) => ["Policy", parent ?? "", name, "Id"],
  "config-bundle": (name) => ["ConfigBundle", name, "Id"],
  // Output arrives with aws/agentcore-l3-cdk-constructs#336; resolves once it ships.
  "capacity-provider": (name) => ["CapacityProvider", name, "Id"],
} satisfies Record<CfnOutputResource, (name: string, parent?: string) => string[]>;

function findDeployedResourceId(
  stack: Stack,
  input: { resourceType: Exclude<DeployableResource, "credential">; name: string; parent?: string },
): string | undefined {
  if (!stack.StackName) return undefined;
  // TODO(cdk): the CLI's payment CfnOutputs (assets/cdk/lib/cdk-stack.ts) set no
  // ExportName, so match by their predictable OutputKey. Once they export a name,
  // fold payment into EXPORT_PARTS and delete this branch.
  if (input.resourceType === "payment") {
    const key = `Payment${toCdkId(input.name)}ManagerId`;
    return stack.Outputs?.find((output) => output.OutputKey === key)?.OutputValue;
  }
  const want = cfnExportName(
    stack.StackName,
    ...EXPORT_PARTS[input.resourceType](input.name, input.parent),
  );
  return stack.Outputs?.find((output) => output.ExportName === want)?.OutputValue;
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

    yield { message: "Synthesizing CloudFormation templates" };
    await this.runner(
      ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", this.assemblyDirectory(project)],
      {
        cwd: cdkDir,
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

    yield { message: `Removing stack ${artifact.stackName}` };
    await this.cdk({ kind: "destroy", stackArtifactId: artifact.id }, options);
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const { target, allowMissing } = input;
    const deployedState = await readDeployedState(this.json, project.rootPath);
    const stackArn = deployedState.targets[target.name]?.stackArn;
    if (!stackArn) {
      if (allowMissing) return [];
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }

    const credentials = await this.credentialsForTarget(target);
    const stack = await this.describeStack(target.region, credentials, stackArn);
    if (!stack) {
      if (allowMissing) return [];
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }

    const { spec } = project;
    // Credential ids are never stack outputs — they're created imperatively and
    // recorded in deployed-state. Read them from the state we already loaded.
    const credentialArns = deployedState.targets[target.name]?.resources?.credentials ?? {};

    type Declared = { resourceType: DeployableResource; name: string; parent?: string };
    const declared: Declared[] = [
      ...spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
      ...spec.harnesses.map(({ name }) => ({ resourceType: "harness" as const, name })),
      ...spec.memories.map(({ name }) => ({ resourceType: "memory" as const, name })),
      ...spec.knowledgeBases.map(({ name }) => ({ resourceType: "knowledge-base" as const, name })),
      ...spec.credentials.map(({ name }) => ({ resourceType: "credential" as const, name })),
      ...spec.evaluators.map(({ name }) => ({ resourceType: "evaluator" as const, name })),
      ...spec.onlineEvalConfigs.map(({ name }) => ({ resourceType: "online-eval" as const, name })),
      ...spec.agentCoreGateways.flatMap((gw) => [
        { resourceType: "gateway" as const, name: gw.name },
        ...(gw.targets ?? []).map(({ name }) => ({
          resourceType: "gateway-target" as const,
          name,
          parent: gw.name,
        })),
      ]),
      ...(spec.unassignedTargets ?? []).map(({ name }) => ({
        resourceType: "gateway-target" as const,
        name,
      })),
      ...spec.policyEngines.flatMap((engine) => [
        { resourceType: "policy-engine" as const, name: engine.name },
        ...(engine.policies ?? []).map(({ name }) => ({
          resourceType: "policy" as const,
          name,
          parent: engine.name,
        })),
      ]),
      ...spec.configBundles.map(({ name }) => ({ resourceType: "config-bundle" as const, name })),
      // datasets are intentionally excluded — out of scope for project status.
      ...(spec.payments ?? []).map(({ name }) => ({ resourceType: "payment" as const, name })),
      // capacity-provider has no spec array yet — arrives with l3-cdk-constructs#336.
    ];

    return declared.flatMap((r) => {
      const id =
        r.resourceType === "credential"
          ? credentialArns[r.name]?.credentialProviderArn
          : findDeployedResourceId(stack, {
              resourceType: r.resourceType,
              name: r.name,
              parent: r.parent,
            });
      return id ? [{ ...r, id, target }] : [];
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
