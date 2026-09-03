import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { MalformedServiceResponseError, ProjectStateError } from "../../../errors/errors";
import type {
  DeployResult,
  Project,
  ProjectEvent,
  DeployableResource,
  ResolvedDeployedResource,
  ResolvedProjectResource,
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
  ResolveProjectResourcesBackendInput,
} from "./types";
import { createCloudFormationClient } from "../../factories";
import type { CreateCloudFormationClient } from "../../types";
import {
  createCredentialProvisioner,
  createPaymentCredentialRemover,
  type CredentialProviderCalls,
  type CredentialProvisioner,
  type DeployedCredentials,
  type PaymentCredentialRemover,
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
import {
  createPaymentConnectorAuthorizationUrlReporter,
  type PaymentConnectorAuthorizationUrlReporter,
} from "./cdk/paymentConnectorAuthorizationUrls";
import { describeStack } from "./cdk/stackReader";

type StackDescriber = typeof describeStack;

/**
 * How many trailing Toolkit lines an operation keeps for error context. Matches
 * the cap streamProcess uses for a failed subprocess's captured output.
 */
const MAX_ERROR_OUTPUT_LINES = 20;

// Payment logical ids drop underscores the same way the template's toCdkId does.
function cdkId(name: string): string {
  return name.replace(/_/g, "");
}

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
  /** Identity client used to provision the project's credential providers. */
  identity: CredentialProviderCalls;
  cdk?: CdkRunner;
  resolveCredentials?: CdkCredentialResolver;
  bootstrap?: BootstrapProbe;
  resolveAccount?: AccountResolver;
  loadBootstrapTemplate?: BootstrapTemplateLoader;
  provisionCredentials?: CredentialProvisioner;
  removePaymentCredentials?: PaymentCredentialRemover;
  describeStack?: StackDescriber;
  reportPaymentConnectorAuthorizationUrls?: PaymentConnectorAuthorizationUrlReporter;
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
  private readonly provisionCredentials: CredentialProvisioner;
  private readonly removePaymentCredentials: PaymentCredentialRemover;
  private readonly describeStack: StackDescriber;
  private readonly reportPaymentConnectorAuthorizationUrls: PaymentConnectorAuthorizationUrlReporter;

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
    this.provisionCredentials =
      config.provisionCredentials ?? createCredentialProvisioner(config.identity);
    this.removePaymentCredentials =
      config.removePaymentCredentials ?? createPaymentCredentialRemover(config.identity);
    this.describeStack =
      config.describeStack ??
      ((region, credentials, stackName) =>
        describeStack(region, credentials, stackName, (name) =>
          readStack(name, region, credentials),
        ));
    this.reportPaymentConnectorAuthorizationUrls =
      config.reportPaymentConnectorAuthorizationUrls ??
      createPaymentConnectorAuthorizationUrlReporter(config.createCloudFormationClient);
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
          cwd: this.cdkDirectory(project),
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

    // Fail on local setup errors (missing toolchain/deps) and malformed state
    // before any AWS mutation, so a local problem never leaves credentials
    // provisioned or the stack ARN unrecorded.
    await this.ensureCdkDependencies(project);
    // Kept from before provisioning rewrites the credentials map: it is the only
    // record of what this target provisioned, and a teardown reached by emptying the
    // spec has no other way to know which providers it owns.
    const recorded =
      (await readDeployedState(this.json, project.rootPath)).targets[target.name]?.resources
        ?.credentials ?? {};

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
      return yield* this.teardown({ project, artifact, input, options, recorded });
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

    // Reported after the stack is up and its ARN recorded: a Quick Create
    // connector is deployed but unusable until someone follows its authorization
    // link, and that link expires minutes after the connector is created.
    yield* this.reportPaymentConnectorAuthorizationUrls(project, {
      stackName: artifact.stackName,
      region: target.region,
      credentials,
    });

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
    recorded,
  }: {
    project: Project;
    artifact: StackArtifact;
    input: DeployBackendInput;
    options: CdkRunOptions;
    /** The credentials deployed-state.json held for this target before the deploy. */
    recorded: DeployedCredentials;
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
    // After the stack, since a resource in it may still be using the provider.
    yield* this.removePaymentCredentials(project, {
      credentials: options.credentials,
      region: target.region,
      recorded,
    });
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

  public async resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    const { target } = input;
    const { spec } = project;
    const deployedState = await readDeployedState(this.json, project.rootPath);
    const recorded = deployedState.targets[target.name];

    // No recorded stack means nothing was ever deployed to this target, which
    // every resource below reports as local-only.
    const stack = recorded?.stackArn
      ? await this.describeStack(
          target.region,
          await this.credentialsForTarget(target),
          recorded.stackArn,
        )
      : undefined;

    const byExportName = (...parts: string[]) => {
      if (!stack?.StackName) return undefined;
      // The CDK library builds every ExportName through this shared helper
      // https://github.com/aws/agentcore-l3-cdk-constructs/blob/main/src/cdk/logical-ids.ts#L84
      const want = [stack.StackName, ...parts]
        .map((part) => part.replace(/_/g, "-").replace(/[^a-zA-Z0-9:-]/g, ""))
        .join("-");
      return stack.Outputs?.find((output) => output.ExportName === want)?.OutputValue;
    };

    const byOutputKey = (key: string) =>
      stack?.Outputs?.find((output) => output.OutputKey === key)?.OutputValue;

    const arnOf = (
      resourceType: DeployableResource,
      name: string,
      owner?: string,
    ): string | undefined => {
      switch (resourceType) {
        case "runtime":
          return byExportName(name, "RuntimeArn");
        case "harness":
          return byExportName("Harness", name, "Arn");
        case "memory":
          return byExportName("Memory", name, "Arn");
        case "knowledge-base":
          return byExportName("KnowledgeBase", name, "Arn");
        case "evaluator":
          return byExportName("Evaluator", name, "Arn");
        case "online-eval":
          return byExportName("OnlineEval", name, "Arn");
        case "gateway":
          return byExportName("Gateway", name, "Arn");
        case "gateway-target":
          // The L3 exports an id for targets and never an ARN
          return byExportName("GatewayTarget", name, "Id");
        case "policy":
          // ExportName: <StackName>-Policy-<engineName>-<policyName>-Arn
          return byExportName("Policy", owner ?? "", name, "Arn");
        case "policy-engine":
          return byExportName("PolicyEngine", name, "Arn");
        case "config-bundle":
          return byExportName("ConfigBundle", name, "Arn");
        case "payment-manager":
          // The CLI template writes the payment outputs. It does not set an
          // exportName on them. Therefore match on the OutputKey. The template
          // makes that key from the manager name.
          // See src/assets/cdk/lib/cdk-stack.ts
          return byOutputKey(`Payment${cdkId(name)}ManagerArn`);
        case "payment-connector":
          // The same template does not set an exportName. Therefore match on the
          // OutputKey. The template writes only a connector id, and never an ARN.
          return byOutputKey(`Payment${cdkId(owner ?? "")}${cdkId(name)}ConnectorId`);
        case "credential":
          // The CLI creates credential providers imperatively. The stack does not
          // contain them. Therefore read the ARN from the deployed state file.
          return recorded?.resources?.credentials?.[name]?.credentialProviderArn;
        default: {
          const unhandled: never = resourceType;
          return unhandled;
        }
      }
    };

    // Resolves one declared resource, and keeps its children with it. The spec
    // already says which resource owns which, so status never has to pair them
    // up again by name. `owner` only builds the export name, so it is not
    // reported.
    const resolve = (
      resourceType: DeployableResource,
      name: string,
      options: { owner?: string; children?: ResolvedProjectResource[] } = {},
    ): ResolvedProjectResource => {
      const id = arnOf(resourceType, name, options.owner);
      return {
        resourceType,
        name,
        ...(options.children?.length ? { children: options.children } : {}),
        ...(id ? { deploymentState: "deployed", id } : { deploymentState: "local-only" }),
      };
    };

    return [
      ...spec.runtimes.map(({ name }) => resolve("runtime", name)),
      ...spec.harnesses.map(({ name }) => resolve("harness", name)),
      ...spec.memories.map(({ name }) => resolve("memory", name)),
      ...spec.knowledgeBases.map(({ name }) => resolve("knowledge-base", name)),
      ...spec.credentials.map(({ name }) => resolve("credential", name)),
      ...spec.evaluators.map(({ name }) => resolve("evaluator", name)),
      ...spec.onlineEvalConfigs.map(({ name }) => resolve("online-eval", name)),
      ...spec.agentCoreGateways.map((gateway) =>
        resolve("gateway", gateway.name, {
          children: (gateway.targets ?? []).map(({ name }) =>
            resolve("gateway-target", name, { owner: gateway.name }),
          ),
        }),
      ),
      ...spec.policyEngines.map((engine) =>
        resolve("policy-engine", engine.name, {
          children: (engine.policies ?? []).map(({ name }) =>
            resolve("policy", name, { owner: engine.name }),
          ),
        }),
      ),
      ...spec.configBundles.map(({ name }) => resolve("config-bundle", name)),
      ...(spec.payments ?? []).map((manager) =>
        resolve("payment-manager", manager.name, {
          children: (manager.connectors ?? []).map(({ name }) =>
            resolve("payment-connector", name, { owner: manager.name }),
          ),
        }),
      ),
    ];
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
