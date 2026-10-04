import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AddResourceInput,
  CreateProjectInput,
  DeployProjectInput,
  DeployResult,
  ExportHarnessInput,
  ExportHarnessResult,
  ResolveDeployedResourceInput,
  ResolveDeployedResourcesInput,
  ResolvedDeployedResource,
  ResolvedDeployedResources,
  ResolveProjectInput,
  ResolveProjectResourcesInput,
  ResolvedProjectResources,
  ResolveTargetInput,
  Project,
  ProjectManager,
  ProjectEvent,
  ProjectResource,
  RemoveResourceInput,
  RemoveResourceResult,
  RemoveResourcesResult,
} from "../../handlers/project/types";
import { RESOURCE_LABELS } from "../../handlers/project/types";
import type { Logger } from "../../logging";
import {
  FsReadWriteJson,
  createLineSplitter,
  requireTool,
  runProcess,
  readTextFile,
  readYamlFile,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../io";
import { withOutputEvents } from "./events";
import { defaultSource, type AssetSource } from "./source";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "./envLocal";
import { getHarnessTemplateResolver, validateHarnessTemplateSource } from "./templates/harness";
import { createProjectTree } from "./templates/project";
import { getRuntimeTemplateResolver } from "./templates/runtime";
import {
  DEFAULT_EXPORT_SYSTEM_PROMPT,
  EXPORT_NOTES_FILENAME,
  buildExportNotesMarkdown,
  mapHarnessToExportPlan,
} from "./templates/export";
import { HarnessSpecSchema, HarnessYamlSchema } from "../../projectSchemas/harness";
import { FsTreeNode } from "./templates/fsTree";
import { getEvaluatorTemplateResolver } from "./templates/evaluator";
import { ProjectSpecSchema, type ManagedBy } from "../../projectSchemas/project";
import { ConfigBundleSchema } from "../../projectSchemas/config-bundle";
import {
  CredentialSchema,
  credentialEnvironmentVariableNames,
} from "../../projectSchemas/credential";
import { MemorySchema } from "../../projectSchemas/memory";
import { EvaluatorSchema } from "../../projectSchemas/evaluator";
import { OnlineEvalConfigSchema } from "../../projectSchemas/online-eval-config";
import { PaymentConnectorSchema, PaymentManagerSchema } from "../../projectSchemas/payment";
import { PolicyEngineSchema, PolicySchema } from "../../projectSchemas/policy";
import { RuntimeEndpointSchema } from "../../projectSchemas/runtime";
import { enclosingProjectRoot, projectSpecPath } from "./fsUtils";
import {
  AgentCoreCLIError,
  DeserializationError,
  InputValidationError,
  InvalidEnvironmentError,
  MalformedServiceResponseError,
  NotImplementedError,
  ProjectStateError,
  RegionUnsupportedFeatureError,
  ResourceNotFoundError,
} from "../../errors/errors";
import { isChinaRegion } from "../partition";
import z from "zod";
import { CdkBackend, type TransactionSearchEnabler } from "./backends/cdk";
import { resolveAwsAccount } from "./backends/cdk/environment";
import type { ProjectBackend } from "./backends/types";
import {
  AgentCoreRegionSchema,
  AwsDeploymentTargetSchema,
  AwsDeploymentTargetsSchema,
  DEFAULT_TARGET_NAME,
  type AwsDeploymentTarget,
} from "../../projectSchemas/aws-targets";
import type { RuntimeResourceConfig } from "../../handlers/project/add/runtime/types";
import type { TemplateRenderer } from "./templates/types";
import { HandlebarsTemplateRenderer } from "./templates/renderer";
import type { CreateCloudFormationClient } from "../types";
import type { CoreIdentityClient } from "../../handlers/identity/types";
import { templateManagesDependencies } from "../../handlers/project/templateProfile";
import { resolveRuntimeTemplateProfile } from "../../handlers/project/runtimeTemplateProfile";
import { isBmaRuntime } from "../../handlers/project/bma";

const TARGETS_EXAMPLE = '[{ "name": "default", "account": "111122223333", "region": "us-east-1" }]';

const NODE_INSTALL_HINT = "Install Node.js: https://nodejs.org/";
const UV_INSTALL_HINT = "Install uv: https://docs.astral.sh/uv/getting-started/installation/";

/**
 * Shown when a runtime template hardwired to an unreachable model provider
 * targets a China (aws-cn) region and takes no --model-provider override
 * (langchain, vercel, `--type import`). Amazon Bedrock, Anthropic, OpenAI, and
 * Gemini cannot be called from China regions; LiteLLM can route to a reachable
 * provider and OpenAICompatible points the OpenAI client at a reachable endpoint.
 */
export const MODEL_PROVIDER_RUNTIMES_CN_MESSAGE =
  "This template's model provider is not accessible from China regions (cn-north-1, " +
  "cn-northwest-1): Amazon Bedrock, Anthropic, OpenAI, and Gemini cannot be used there, and " +
  "this template takes no --model-provider override. Pick a strands template " +
  "(agent-python-strands, agent-python-strands-container, a2a-python-strands, " +
  "agui-python-strands, or agent-typescript-strands) with --model-provider litellm " +
  "--model-id <model reachable from China> (Python) or --model-provider openai_compatible " +
  "--api-base <OpenAI-compatible endpoint reachable from China> --model-id <model>, or " +
  "scaffold a provider-free " +
  "runtime (--template agent-python-minimal or mcp-python-fastmcp) and bring your own model " +
  "connectivity.";

/**
 * Shown when a template that DOES take --model-provider is left on (or set to)
 * a provider unreachable from China: the template is fine, only the provider
 * needs to change. TypeScript templates have no LiteLLM, so only the
 * OpenAICompatible route is offered there.
 */
export function modelProviderOverridableCnMessage(
  provider: string,
  language: "Python" | "TypeScript" | undefined,
): string {
  const name = provider === "Bedrock" ? "Amazon Bedrock" : provider;
  const others = ["Amazon Bedrock", "Anthropic", "OpenAI", "Gemini"]
    .filter((p) => p !== name)
    .join(", ");
  const compatible =
    "--model-provider openai_compatible --api-base <OpenAI-compatible endpoint reachable from " +
    "China> --model-id <model>";
  const routes =
    language === "TypeScript"
      ? compatible
      : `--model-provider litellm --model-id <model reachable from China>, or ${compatible}`;
  return (
    `${name} is not accessible from China regions (cn-north-1, cn-northwest-1), and neither ` +
    `are ${others}. To use this template, point it at a model reachable from China: ${routes}.`
  );
}

/** Shown when a Bedrock Managed Agents environment targets the aws-cn partition. */
export const BMA_CN_MESSAGE =
  "Bedrock Managed Agents is not available in China regions (cn-north-1, cn-northwest-1). " +
  "Choose a supported commercial or GovCloud region.";

/**
 * Shown when a harness is created in or deployed to a China (aws-cn) region.
 * Harnesses are not part of the China launch: their model providers and IAM
 * role generation are not partition-aware there.
 */
export const HARNESS_CN_MESSAGE =
  "Harness projects are not available in China regions (cn-north-1, cn-northwest-1). " +
  "Scaffold a runtime project " +
  "instead (e.g. --template agent-python-minimal) or start from --template empty.";

/**
 * The resource families whose CloudFormation types ARE registered in the
 * China regions (verified against cn-north-1's public registry): Runtime,
 * RuntimeEndpoint, Gateway (+Target/+RateLimit), and Identity credentials.
 * Declared as an allowlist so any family added later defaults to blocked in
 * China until its availability there is confirmed.
 */
const CN_SUPPORTED_RESOURCE_TYPES = new Set<AddResourceInput["resourceType"]>([
  "runtime",
  "runtime-endpoint",
  "credential",
  "gateway",
  "gateway-target",
]);

/**
 * The project spec collections deployable to a China region — the spec-file
 * counterpart of {@link CN_SUPPORTED_RESOURCE_TYPES} (toolRuntimes render as
 * Runtime resources). Any other non-empty array collection in the spec,
 * including ones added in the future, blocks a China deploy.
 */
const CN_SUPPORTED_SPEC_COLLECTIONS = new Set([
  "runtimes",
  "credentials",
  "agentCoreGateways",
  "toolRuntimes",
]);

/** Shown when an `add` targets a resource family that is unavailable in China regions. */
export function cnUnsupportedResourceMessage(resourceType: string): string {
  return (
    `'${resourceType}' resources are not available in China regions (cn-north-1, ` +
    `cn-northwest-1), and this project has a China deployment target.`
  );
}

/**
 * Shown when the default memory is dropped from a China scaffold. The rendered
 * code keeps the memory module (it degrades to no memory while its env var is
 * absent), so a memory can be added without code changes once available.
 */
export const MEMORY_STRIPPED_CN_MESSAGE =
  "AgentCore Memory is not available in China regions (cn-north-1, cn-northwest-1); " +
  "scaffolding without the default memory";

/**
 * Shown when a LiteLLM runtime template targets a China (aws-cn) region without
 * an explicit model id: the LiteLLM default routes to Amazon Bedrock, which is
 * not available there.
 */
export const LITELLM_MODEL_ID_REQUIRED_CN_MESSAGE =
  "--model-provider litellm requires --model-id in China regions (cn-north-1, " +
  "cn-northwest-1): the default model id " +
  "routes to Amazon Bedrock, which is not available there. Pass a LiteLLM model id for a " +
  "provider reachable from China (see https://docs.litellm.ai/docs/providers).";

/**
 * The China (aws-cn) rule for a runtime scaffold's model wiring, shared by the
 * create-time gate and the add-time gate so both give the same verdict:
 * provider-free scaffolds pass; LiteLLM passes with an explicit, non-Bedrock
 * model id; OpenAICompatible passes (the user chose the endpoint); everything
 * else, OpenAI included, is unreachable from China. Returns the message to
 * refuse with, or undefined.
 */
export function chinaModelProviderRestriction(scaffold: {
  framework: string;
  language?: "Python" | "TypeScript";
  modelProvider?: string;
  modelId?: string;
  templateProfile?: { modelProviderOverride?: boolean };
}): string | undefined {
  if (scaffold.framework === "none") return undefined;
  const provider = scaffold.modelProvider ?? "Bedrock";
  if (provider === "OpenAICompatible") return undefined;
  if (provider !== "LiteLLM") {
    return scaffold.templateProfile?.modelProviderOverride === true
      ? modelProviderOverridableCnMessage(provider, scaffold.language)
      : MODEL_PROVIDER_RUNTIMES_CN_MESSAGE;
  }
  if (scaffold.modelId === undefined) return LITELLM_MODEL_ID_REQUIRED_CN_MESSAGE;
  if (scaffold.modelId.startsWith("bedrock/")) return LITELLM_BEDROCK_MODEL_ID_CN_MESSAGE;
  return undefined;
}

/**
 * Shown when a LiteLLM runtime explicitly targets LiteLLM's Bedrock route
 * (the 'bedrock/' model id prefix) in a China (aws-cn) region.
 */
export const LITELLM_BEDROCK_MODEL_ID_CN_MESSAGE =
  "the 'bedrock/' LiteLLM model id prefix routes to Amazon Bedrock, which is not available " +
  "in China regions (cn-north-1, cn-northwest-1). Pass a LiteLLM model id for a provider " +
  "reachable from China (see https://docs.litellm.ai/docs/providers).";
const GIT_INSTALL_HINT = "Install git: https://git-scm.com/downloads";

// npm prints nothing until it exits when stderr is piped, and its HTTP log is the only per-package
// progress it will emit, so the log is asked for and then rewritten into package names.
const NPM_INSTALL = ["npm", "install", "--loglevel=http"];
const NPM_FETCH = /^npm http fetch [A-Z]+ \d{3} https?:\/\/[^/]+(\S*)/;

function npmProgressLine(line: string): string | undefined {
  const path = NPM_FETCH.exec(line)?.[1];
  // Deprecation warnings and the closing summary are already written for people.
  if (path === undefined) return line;
  // `/-/npm/v1/...` names no package; the only one an install makes is the audit request.
  if (path.startsWith("/-/")) return "auditing dependencies";
  // A private registry may serve manifests under a prefix, so the name is the path's tail. A scope
  // reaches us either as its own segment or encoded into one as %2f.
  const [manifest = "", tarball] = path.split("/-/");
  const segments = manifest.replace(/%2f/gi, "/").split("/").filter(Boolean);
  const scope = segments.at(-2);
  const name = scope?.startsWith("@") ? `${scope}/${segments.at(-1)}` : segments.at(-1);
  if (name === undefined) return undefined;
  return `${tarball === undefined ? "resolving" : "downloading"} ${name}`;
}

type ProjectManagerConfig = {
  logger: Logger;
  createCloudFormationClient?: CreateCloudFormationClient;
  /**
   * Identity operations a deploy provisions credential providers through. Required
   * rather than defaulted, so a caller that forgets one fails to compile instead of
   * silently getting a client that talks to AWS.
   */
  identity: CoreIdentityClient;
  /**
   * Enables CloudWatch Transaction Search for a deploy target. Required rather
   * than defaulted so it always routes through the caller's shared clients (and
   * their record/replay seam) instead of constructing raw SDK clients here.
   */
  enableTransactionSearch: TransactionSearchEnabler;
  source?: AssetSource;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  backends?: Partial<Record<ManagedBy, ProjectBackend>>;
  templateRenderer?: TemplateRenderer;
  /**
   * Resolves the AWS account behind the active credentials (STS
   * GetCallerIdentity), used to synthesize the default deployment target.
   * Injectable so unit tests never call AWS.
   */
  resolveAccount?: (region: string) => Promise<string>;
};

/**
 * An implementation of {@link ProjectManager} that relies on the local file system to manage projects.
 */
export class FsProjectManager implements ProjectManager {
  private readonly logger: Logger;
  private readonly assetSource: AssetSource;
  private readonly templateRenderer: TemplateRenderer;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly backends: Partial<Record<ManagedBy, ProjectBackend>>;
  private readonly resolveAccount: (region: string) => Promise<string>;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.assetSource = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.backends = config.backends ?? {
      CDK: new CdkBackend({
        logger: config.logger,
        createCloudFormationClient: config.createCloudFormationClient,
        identity: config.identity,
        enableTransactionSearch: config.enableTransactionSearch,
        runner: config.runner,
        checkTool: config.checkTool,
        json: config.json,
      }),
    };
    this.templateRenderer = config.templateRenderer ?? new HandlebarsTemplateRenderer();
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const rootPath = enclosingProjectRoot(input.filePath);
    if (!rootPath) return undefined;

    const configPath = projectSpecPath(rootPath);
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

    if (input.scaffoldHarnessInput) {
      validateHarnessTemplateSource(input.scaffoldHarnessInput);
    }

    const scaffoldRuntimeInput = input.scaffoldRuntimeInput;
    const destination = join(process.cwd(), input.name);

    const { tree: projectTree, envEntries } = await createProjectTree(
      { templateRenderer: this.templateRenderer, assetSource: this.assetSource },
      { projectName: input.name },
      { runtime: scaffoldRuntimeInput, importBedrockAgent: input.importBedrockAgent },
    );

    // Validate required tools exist before starting creation flow
    await this.checkCreateDependencies(input);

    yield { type: "step", message: "Creating project tree" };
    await projectTree.write(destination);

    if (envEntries.length > 0) {
      yield { type: "step", message: "Writing model provider API key to agentcore/.env.local" };
      await new EnvLocalFile(destination).insertIfNew(envEntries);
    }

    // A harness project scaffolds through the same addResource flow that
    // `agentcore add harness` uses, so a create-time harness and an added one can
    // never drift apart.
    if (input.scaffoldHarnessInput) {
      const scaffolded = await this.resolve({ filePath: destination });
      if (!scaffolded) {
        throw new ProjectStateError(
          `the project scaffolded at ${destination} could not be read back`,
        );
      }
      yield* this.addResource(scaffolded, {
        resourceType: "harness",
        resourceConfig: input.scaffoldHarnessInput,
      });
    }

    // A failed step leaves the scaffolded files in place; the error carries the
    // failing command, its directory, and its output.
    if (!input.skipInstall) {
      yield { type: "step", message: "Installing CDK dependencies with npm" };
      yield* this.run(NPM_INSTALL, join(destination, "agentcore", "cdk"), npmProgressLine);

      if (scaffoldRuntimeInput) {
        const appDir = join(destination, "app", scaffoldRuntimeInput.runtimeName);
        yield* this.installRuntimeDependencies(appDir, scaffoldRuntimeInput);
      }
    } else if (
      scaffoldRuntimeInput?.build === "Container" &&
      templateManagesDependencies(resolveRuntimeTemplateProfile(scaffoldRuntimeInput))
    ) {
      // Container builds install from a lockfile, so generate it even with no-install.
      const appDir = join(destination, "app", scaffoldRuntimeInput.runtimeName);
      yield* this.ensureLockFileExists(appDir);
    }

    if (!input.skipGit) {
      yield { type: "step", message: "Initializing git repository" };
      yield* this.run(["git", "init"], destination);
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
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const projectSpecKey = toProjectSpecKey(input.resourceType);

    yield { type: "step", message: `Reading project spec file at '${agentCoreSpecPath}'` };
    const projectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    const existingResources = projectSpec[projectSpecKey] ?? [];
    if (input.resourceType === "gateway-target") {
      // Current L3 outputs are keyed only by Target name, so names must remain
      // project-unique until those outputs include the parent Gateway.
      const gateway = projectSpec.agentCoreGateways.find((candidate) =>
        candidate.targets.some((target) => target.name === input.resourceConfig.name),
      );
      if (gateway) {
        throw new InputValidationError(
          `a gateway target with name '${input.resourceConfig.name}' already exists in gateway '${gateway.name}'`,
        );
      }
    } else if (input.resourceType === "policy") {
      // Policy names are account-unique on the service, so the check spans engines.
      const engine = projectSpec.policyEngines.find((candidate) =>
        candidate.policies.some((policy) => policy.name === input.resourceConfig.name),
      );
      if (engine) {
        throw new InputValidationError(
          `a policy with name '${input.resourceConfig.name}' already exists in policy engine '${engine.name}'`,
        );
      }
    } else if (input.resourceType === "payment-connector") {
      const manager = projectSpec.payments?.find(
        (candidate) => candidate.name === input.managerName,
      );
      if (!manager) {
        throw new ResourceNotFoundError(
          `no payment-manager named '${input.managerName}' exists in this project`,
        );
      }
      if (manager.connectors.some((connector) => connector.name === input.resourceConfig.name)) {
        throw new InputValidationError(
          `a payment connector with name '${input.resourceConfig.name}' already exists in manager '${input.managerName}'`,
        );
      }
    } else if (input.resourceType === "runtime-endpoint") {
      const runtime = projectSpec.runtimes.find(
        (candidate) => candidate.name === input.runtimeName,
      );
      if (!runtime) {
        throw new ResourceNotFoundError(
          `no runtime named '${input.runtimeName}' exists in this project`,
        );
      }
      if (runtime.endpoints?.[input.resourceConfig.name]) {
        throw new InputValidationError(
          `a runtime-endpoint named '${input.resourceConfig.name}' already exists on runtime '${input.runtimeName}'`,
        );
      }
    } else if (existingResources.find((resource) => resource.name === input.resourceConfig.name)) {
      throw new InputValidationError(
        `a ${input.resourceType} with name '${input.resourceConfig.name}' already exists`,
      );
    }

    const scaffoldedPaths: string[] = [];
    let envFile: EnvLocalFile | undefined;

    // A project with a China (aws-cn) deployment target can only add the
    // resource families whose CloudFormation types exist there (Runtime,
    // Gateway, credential). Runtimes additionally gate on the model provider
    // — Bedrock/Anthropic/OpenAI/Gemini are unreachable, LiteLLM needs an
    // explicit model id (its default routes to Bedrock) — and the default
    // memory is dropped from the scaffold (see MEMORY_STRIPPED_CN_MESSAGE);
    // provider-free scaffolds (framework "none": minimal, MCP) stay available
    // as the bring-your-own-implementation path.
    if ((await this.listTargets(project)).some((target) => isChinaRegion(target.region))) {
      if (input.resourceType === "harness") {
        throw new RegionUnsupportedFeatureError(HARNESS_CN_MESSAGE);
      }
      if (!CN_SUPPORTED_RESOURCE_TYPES.has(input.resourceType)) {
        throw new RegionUnsupportedFeatureError(cnUnsupportedResourceMessage(input.resourceType));
      }
      if (input.resourceType === "runtime") {
        const scaffold = input.resourceConfig.scaffoldRuntimeInput;
        if (scaffold.framework === "bma") {
          throw new RegionUnsupportedFeatureError(BMA_CN_MESSAGE);
        }
        const restriction = chinaModelProviderRestriction(scaffold);
        if (restriction !== undefined) {
          throw new RegionUnsupportedFeatureError(restriction);
        }
        if (scaffold.memory !== undefined) {
          input.resourceConfig.scaffoldRuntimeInput.memory = undefined;
          yield { type: "step", message: MEMORY_STRIPPED_CN_MESSAGE };
        }
      }
    }

    switch (input.resourceType) {
      case "harness": {
        yield { type: "step", message: `Scaffolding harness in project` };
        const outputPath = join(project.rootPath, "app", input.resourceConfig.name);
        scaffoldedPaths.push(outputPath);

        const resolver = getHarnessTemplateResolver({
          assetSource: this.assetSource,
          templateRenderer: this.templateRenderer,
        });
        const result = await resolver.resolve(input.resourceConfig);
        await result.tree.write(dirname(outputPath));
        if (result.spec.harnesses) projectSpec.harnesses.push(...result.spec.harnesses);
        break;
      }
      case "runtime": {
        await this.checkRuntimeDependency(input.resourceConfig.scaffoldRuntimeInput);
        yield { type: "step", message: "Scaffolding runtime in project" };
        const outputPath = join(project.rootPath, "app", input.resourceConfig.name);
        scaffoldedPaths.push(outputPath);

        const { spec, envEntries } = await this.scaffoldRuntimeResources(
          outputPath,
          input.resourceConfig,
        );
        if (spec.runtimes) projectSpec.runtimes.push(...spec.runtimes);
        if (spec.memories) projectSpec.memories.push(...spec.memories);
        if (spec.credentials) projectSpec.credentials.push(...spec.credentials);
        if (envEntries.length > 0) {
          envFile = new EnvLocalFile(project.rootPath);
          yield { type: "step", message: `Updating secrets file at '${envFile.path}'` };
          const { skipped } = await envFile.insertIfNew(envEntries);
          for (const key of skipped) {
            yield {
              type: "step",
              message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
            };
          }
        }

        yield* this.installRuntimeDependencies(
          outputPath,
          input.resourceConfig.scaffoldRuntimeInput,
        );
        break;
      }
      case "credential": {
        const credential = parseResource(CredentialSchema, input.resourceConfig);
        projectSpec.credentials.push(credential);
        if (input.envEntries?.length) {
          envFile = new EnvLocalFile(project.rootPath);
          yield { type: "step", message: `Updating secrets file at '${envFile.path}'` };
          const { skipped } = await envFile.insertIfNew(input.envEntries);
          for (const key of skipped) {
            yield {
              type: "step",
              message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
            };
          }
        }
        break;
      }
      case "config-bundle": {
        projectSpec.configBundles.push(parseResource(ConfigBundleSchema, input.resourceConfig));
        break;
      }
      case "online-eval":
      case "online-insight": {
        projectSpec.onlineEvalConfigs.push(
          parseResource(OnlineEvalConfigSchema, input.resourceConfig),
        );
        break;
      }
      case "memory": {
        projectSpec.memories.push(parseResource(MemorySchema, input.resourceConfig));
        break;
      }
      case "evaluator": {
        if (input.scaffold) {
          yield { type: "step", message: "Scaffolding evaluator in project" };
          const outputPath = join(project.rootPath, "app", input.scaffold.name);
          if (existsSync(outputPath))
            throw new InputValidationError(
              `cannot scaffold evaluator '${input.scaffold.name}': 'app/${input.scaffold.name}' already exists (another resource may use this name, or a previous scaffold was left behind)`,
            );
          scaffoldedPaths.push(outputPath);
          const result = await getEvaluatorTemplateResolver({
            assetSource: this.assetSource,
            templateRenderer: this.templateRenderer,
          }).resolve(input.scaffold);
          await result.tree.write(dirname(outputPath));
          projectSpec.evaluators.push(...(result.spec.evaluators ?? []));
        } else {
          projectSpec.evaluators.push(parseResource(EvaluatorSchema, input.resourceConfig));
        }
        break;
      }
      case "gateway":
        projectSpec.agentCoreGateways.push(input.resourceConfig);
        break;
      case "payment-manager": {
        projectSpec.payments ??= [];
        projectSpec.payments.push(parseResource(PaymentManagerSchema, input.resourceConfig));
        break;
      }
      case "policy-engine": {
        projectSpec.policyEngines.push(parseResource(PolicyEngineSchema, input.resourceConfig));
        for (const gatewayName of input.attachGateways?.names ?? []) {
          const gateway = projectSpec.agentCoreGateways.find(
            (candidate) => candidate.name === gatewayName,
          );
          if (!gateway) {
            throw new ResourceNotFoundError(
              `no gateway named '${gatewayName}' exists in this project`,
            );
          }
          gateway.policyEngineConfiguration = {
            policyEngineName: input.resourceConfig.name,
            mode: input.attachGateways!.mode,
          };
        }
        break;
      }
      case "policy": {
        const engine = projectSpec.policyEngines.find(
          (candidate) => candidate.name === input.engineName,
        );
        if (!engine) {
          throw new ResourceNotFoundError(
            `no policy-engine named '${input.engineName}' exists in this project`,
          );
        }
        engine.policies.push(parseResource(PolicySchema, input.resourceConfig));
        break;
      }
      case "gateway-target": {
        const gatewayIndex = projectSpec.agentCoreGateways.findIndex(
          (gateway) => gateway.name === input.gatewayName,
        );
        if (gatewayIndex < 0) {
          throw new ResourceNotFoundError(
            `no gateway named '${input.gatewayName}' exists in this project`,
          );
        }
        projectSpec.agentCoreGateways[gatewayIndex]!.targets.push(input.resourceConfig);
        break;
      }
      case "payment-connector": {
        const manager = projectSpec.payments!.find(
          (candidate) => candidate.name === input.managerName,
        )!;
        manager.connectors.push(parseResource(PaymentConnectorSchema, input.resourceConfig));
        break;
      }
      case "runtime-endpoint": {
        const runtime = projectSpec.runtimes.find(
          (candidate) => candidate.name === input.runtimeName,
        )!;
        runtime.endpoints ??= {};
        runtime.endpoints[input.resourceConfig.name] = parseResource(RuntimeEndpointSchema, {
          version: input.resourceConfig.version,
          ...(input.resourceConfig.description
            ? { description: input.resourceConfig.description }
            : {}),
        });
        break;
      }
      default: {
        const unhandled: never = input;
        throw new NotImplementedError(`unsupported project resource: ${String(unhandled)}`);
      }
    }

    yield { type: "step", message: `Updating project spec file at '${agentCoreSpecPath}'` };

    let newProjectSpec: z.infer<typeof ProjectSpecSchema>;
    try {
      const newSpecParseResult = ProjectSpecSchema.safeParse(projectSpec);
      if (!newSpecParseResult.success)
        throw new ProjectStateError(z.prettifyError(newSpecParseResult.error), {
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
    return projectSpecPath(project.rootPath);
  }

  public async removeResource(
    project: Project,
    input: RemoveResourceInput,
  ): Promise<RemoveResourceResult> {
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    let removed = false;
    let newSpec: unknown;
    let removedResource = input;
    if (input.resourceType === "policy") {
      const candidates = existingProjectSpec.policyEngines.filter((engine) =>
        engine.policies.some((policy) => policy.name === input.name),
      );
      if (!input.engineName && candidates.length > 1) {
        throw new InputValidationError(
          `policy '${input.name}' exists in multiple engines: ${candidates
            .map((engine) => engine.name)
            .join(", ")}; use --engine to choose one`,
        );
      }
      const owner = input.engineName
        ? candidates.find((engine) => engine.name === input.engineName)
        : candidates[0];
      removed = owner !== undefined;
      if (owner) removedResource = { ...input, engineName: owner.name };
      const engines = existingProjectSpec.policyEngines.map((engine) =>
        engine === owner
          ? { ...engine, policies: engine.policies.filter((policy) => policy.name !== input.name) }
          : engine,
      );
      newSpec = { ...existingProjectSpec, policyEngines: engines };
    } else if (input.resourceType === "policy-engine") {
      const engines = existingProjectSpec.policyEngines.filter(
        (engine) => engine.name !== input.name,
      );
      removed = engines.length !== existingProjectSpec.policyEngines.length;
      const gateways = existingProjectSpec.agentCoreGateways.map((gateway) =>
        gateway.policyEngineConfiguration?.policyEngineName === input.name
          ? { ...gateway, policyEngineConfiguration: undefined }
          : gateway,
      );
      newSpec = { ...existingProjectSpec, policyEngines: engines, agentCoreGateways: gateways };
    } else if (input.resourceType === "gateway-target") {
      const gateways = [...existingProjectSpec.agentCoreGateways];
      const gatewayIndex = gateways.findIndex((gateway) => gateway.name === input.gatewayName);
      if (gatewayIndex < 0) {
        throw new ResourceNotFoundError(
          `no gateway named '${input.gatewayName}' exists in this project`,
        );
      }
      const gateway = gateways[gatewayIndex]!;
      const targets = gateway.targets.filter((target) => target.name !== input.name);
      removed = targets.length !== gateway.targets.length;
      gateways[gatewayIndex] = { ...gateway, targets };
      newSpec = { ...existingProjectSpec, agentCoreGateways: gateways };
    } else if (input.resourceType === "payment-connector") {
      const payments = [...(existingProjectSpec.payments ?? [])];
      const managerIndex = payments.findIndex((manager) => manager.name === input.managerName);
      if (managerIndex < 0) {
        throw new ResourceNotFoundError(
          `no payment-manager named '${input.managerName}' exists in this project`,
        );
      }
      const manager = payments[managerIndex]!;
      const connectors = manager.connectors.filter((connector) => connector.name !== input.name);
      removed = connectors.length !== manager.connectors.length;
      payments[managerIndex] = { ...manager, connectors };
      newSpec = { ...existingProjectSpec, payments };
    } else if (input.resourceType === "runtime-endpoint") {
      const runtimes = [...existingProjectSpec.runtimes];
      const runtimeIndex = runtimes.findIndex((runtime) => runtime.name === input.runtimeName);
      if (runtimeIndex < 0) {
        throw new ResourceNotFoundError(
          `no runtime named '${input.runtimeName}' exists in this project`,
        );
      }
      const runtime = runtimes[runtimeIndex]!;
      if (runtime.endpoints?.[input.name]) {
        const { [input.name]: _removed, ...rest } = runtime.endpoints;
        // Drop the endpoints key entirely when the last endpoint goes, mirroring
        // how removeResource prunes an emptied payment manager's connectors.
        runtimes[runtimeIndex] = {
          ...runtime,
          endpoints: Object.keys(rest).length > 0 ? rest : undefined,
        };
        removed = true;
      }
      newSpec = { ...existingProjectSpec, runtimes };
    } else {
      const projectSpecKey = toProjectSpecKey(input.resourceType);
      const existingResources = existingProjectSpec[projectSpecKey] ?? [];
      const newResources = existingResources.filter((resource) => resource.name !== input.name);
      removed = newResources.length !== existingResources.length;
      newSpec = { ...existingProjectSpec, [projectSpecKey]: newResources };
    }

    if (!removed) {
      throw new ResourceNotFoundError(
        `no ${input.resourceType} named '${input.name}' exists in this project`,
      );
    }

    // A credential's secret material lives in .env.local, so removing the
    // credential also deletes the keys it reserved (none when an external
    // secretRef holds the material).
    let envFile: EnvLocalFile | undefined;
    let removedEnvKeys: string[] = [];
    if (input.resourceType === "credential") {
      const credential = existingProjectSpec.credentials.find(
        (candidate) => candidate.name === input.name,
      )!;
      const envKeys = credentialEnvironmentVariableNames(credential);
      if (envKeys.length > 0) {
        envFile = new EnvLocalFile(project.rootPath);
        removedEnvKeys = (await envFile.removeKeys(envKeys)).removed;
      }
    }

    const newProjectSpec = await this.commitSpec(agentCoreSpecPath, newSpec, envFile);

    return {
      project: { ...project, spec: newProjectSpec },
      removedEnvKeys,
      removedResource,
    };
  }

  public async removeAllResources(project: Project): Promise<RemoveResourcesResult> {
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    let envFile: EnvLocalFile | undefined;
    let removedEnvKeys: string[] = [];
    const envKeys = existingProjectSpec.credentials.flatMap((credential) =>
      credentialEnvironmentVariableNames(credential),
    );
    if (envKeys.length > 0) {
      envFile = new EnvLocalFile(project.rootPath);
      removedEnvKeys = (await envFile.removeKeys(envKeys)).removed;
    }

    // A spec-level reset, mirroring the original CLI's `remove all`: every
    // resource collection is emptied while name, version, managedBy, and tags
    // survive. Code under app/ and aws-targets.json are left in place
    // so a following deploy can tear down the target's stack.
    const newSpec = {
      ...existingProjectSpec,
      runtimes: [],
      memories: [],
      knowledgeBases: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      harnesses: [],
      toolRuntimes: undefined,
      payments: undefined,
    };

    const newProjectSpec = await this.commitSpec(agentCoreSpecPath, newSpec, envFile);

    return {
      project: { ...project, spec: newProjectSpec },
      removedEnvKeys,
    };
  }

  // Validates and writes an updated spec; a failure rolls back any .env.local
  // edit staged for the same removal so the two files stay consistent.
  private async commitSpec(
    agentCoreSpecPath: string,
    newSpec: unknown,
    envFile: EnvLocalFile | undefined,
  ): Promise<z.infer<typeof ProjectSpecSchema>> {
    try {
      const newSpecParseResult = ProjectSpecSchema.safeParse(newSpec);
      if (!newSpecParseResult.success)
        throw new InputValidationError(z.prettifyError(newSpecParseResult.error), {
          cause: newSpecParseResult.error,
        });
      return await this.json.write(agentCoreSpecPath, newSpecParseResult.data);
    } catch (err) {
      await envFile?.rollback().catch((e) => {
        const error = AgentCoreCLIError.fromError(e);
        this.logger
          .child({ errorName: error.name, errorMessage: error.message })
          .warn(`failed to roll back ${ENV_LOCAL_RELATIVE_PATH}`);
      });
      throw err;
    }
  }

  public async *exportHarness(
    project: Project,
    input: ExportHarnessInput,
  ): AsyncGenerator<ProjectEvent, ExportHarnessResult> {
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const { targetAgentName } = input;

    yield { type: "step", message: `Reading project spec file at '${agentCoreSpecPath}'` };
    const projectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    // Resolve the harness spec + system prompt: from the prefetched service
    // payload (--arn) or from the in-project harness files (--name).
    let harnessName: string;
    let spec: z.output<typeof HarnessSpecSchema>;
    let systemPrompt: string;
    let harnessDir: string | undefined;
    if (input.prefetched) {
      spec = input.prefetched.spec;
      harnessName = spec.name;
      const prompt = input.prefetched.systemPrompt?.trim();
      systemPrompt =
        prompt && prompt.length > 0 ? prompt : (spec.systemPrompt ?? DEFAULT_EXPORT_SYSTEM_PROMPT);
    } else {
      harnessName = input.harnessName!;
      const entry = projectSpec.harnesses.find((candidate) => candidate.name === harnessName);
      if (!entry) {
        const available = projectSpec.harnesses.map((candidate) => candidate.name).join(", ");
        throw new ResourceNotFoundError(
          `Harness '${harnessName}' not found in agentcore.json. ` +
            `Available harnesses: ${available || "none"}`,
        );
      }
      harnessDir = join(project.rootPath, entry.path);
      yield {
        type: "step",
        message: `Reading harness configuration from '${join(entry.path, "harness.yaml")}'`,
      };
      const harnessPath = join(harnessDir, "harness.yaml");
      const parsed = HarnessYamlSchema.safeParse(await readYamlFile(harnessPath));
      if (!parsed.success) {
        throw new InputValidationError(
          `Invalid harness.yaml at '${harnessPath}': ${z.prettifyError(parsed.error)}`,
          { cause: parsed.error },
        );
      }
      spec = parsed.data;
      systemPrompt = spec.systemPrompt ?? DEFAULT_EXPORT_SYSTEM_PROMPT;
      if (spec.systemPrompt === undefined) {
        const promptPath = join(harnessDir, "system-prompt.md");
        try {
          systemPrompt = await readTextFile(promptPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new DeserializationError(promptPath, {
              cause: error,
              details: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!systemPrompt.trim()) {
          throw new InputValidationError(
            `System prompt file '${promptPath}' is empty or whitespace-only.`,
          );
        }
      }
    }

    // Refuse to overwrite anything: the target name must be free in the spec
    // (runtimes AND harnesses share the app/ namespace) and on disk. A leftover
    // directory with no spec entry would otherwise be silently overwritten.
    if (projectSpec.runtimes.some((runtime) => runtime.name === targetAgentName)) {
      throw new InputValidationError(
        `a runtime with name '${targetAgentName}' already exists; choose a different --target-agent-name`,
      );
    }
    if (projectSpec.harnesses.some((harness) => harness.name === targetAgentName)) {
      throw new InputValidationError(
        `a harness with name '${targetAgentName}' already exists; choose a different --target-agent-name`,
      );
    }
    const agentDir = join(project.rootPath, "app", targetAgentName);
    if (existsSync(agentDir)) {
      throw new InputValidationError(
        `the directory 'app/${targetAgentName}/' already exists; remove it or choose a different --target-agent-name`,
      );
    }

    yield {
      type: "step",
      message: `Mapping harness '${harnessName}' to the Strands runtime template`,
    };
    const plan = mapHarnessToExportPlan({
      harnessName,
      targetAgentName,
      spec,
      systemPrompt,
      projectSpec,
      sourceNotes: input.prefetched?.notes,
      modelAdditionalParams: input.prefetched?.modelAdditionalParams,
    });

    yield { type: "step", message: `Rendering agent code at 'app/${targetAgentName}'` };
    const tree = await FsTreeNode.fromAssetSource(
      { assetSource: this.assetSource },
      { assetDir: "templates/export-harness-python" },
      {
        rootDirName: targetAgentName,
        transformContent: (raw) => this.templateRenderer.render(raw, plan.context),
        filter: (name, isDir) => (isDir && name === "memory" ? plan.hasMemory : true),
      },
    );

    // Everything under agentDir is created by this export; remove it when a
    // later step fails so no orphan directory outlives its spec entry.
    const cleanupAgentDir = () =>
      rm(agentDir, { recursive: true, force: true }).catch((e) => {
        const error = AgentCoreCLIError.fromError(e);
        this.logger
          .child({ errorName: error.name, errorMessage: error.message })
          .warn(`failed to clean up ${agentDir}`);
      });

    let envFile: EnvLocalFile | undefined;
    try {
      await tree.write(join(project.rootPath, "app"));

      // Post-render files the template cannot express.
      for (const [fileName, policyDoc] of Object.entries(plan.policyFiles)) {
        await writeFile(join(agentDir, fileName), `${JSON.stringify(policyDoc, null, 2)}\n`);
      }

      yield { type: "step", message: `Writing ${EXPORT_NOTES_FILENAME}` };
      const notesPath = join(agentDir, EXPORT_NOTES_FILENAME);
      await writeFile(
        notesPath,
        buildExportNotesMarkdown(
          plan.notes,
          harnessName,
          targetAgentName,
          await readStrandsVersion(agentDir),
        ),
      );

      if (plan.envEntries.length > 0) {
        envFile = new EnvLocalFile(project.rootPath);
        yield { type: "step", message: `Updating secrets file at '${envFile.path}'` };
        const { skipped } = await envFile.insertIfNew(plan.envEntries);
        for (const key of skipped) {
          yield {
            type: "step",
            message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
          };
        }
      }

      yield { type: "step", message: `Updating project spec file at '${agentCoreSpecPath}'` };
      projectSpec.runtimes.push(plan.runtime);
      for (const credential of plan.credentials) {
        if (!projectSpec.credentials.some((candidate) => candidate.name === credential.name)) {
          projectSpec.credentials.push(credential);
        }
      }
      const parsed = ProjectSpecSchema.safeParse(projectSpec);
      if (!parsed.success) {
        throw new ProjectStateError(z.prettifyError(parsed.error), { cause: parsed.error });
      }
      await this.json.write(agentCoreSpecPath, parsed.data);
    } catch (err) {
      this.logger.warn(
        `harness export failed; attempting best-effort cleanup of staged changes under ${agentDir}`,
      );
      await Promise.all([
        cleanupAgentDir(),
        envFile?.rollback().catch((e) => {
          const error = AgentCoreCLIError.fromError(e);
          this.logger
            .child({ errorName: error.name, errorMessage: error.message })
            .warn(`failed to roll back ${ENV_LOCAL_RELATIVE_PATH}`);
        }),
      ]);
      throw err;
    }

    // Deps go in only after the spec commit: a sync failure past this point
    // leaves a consistent project the user can finish with a manual `uv sync`,
    // so it must NOT trigger the cleanup above.
    yield* this.installRuntimeDependencies(agentDir);

    return {
      harnessName,
      agentName: targetAgentName,
      agentPath: agentDir,
      notesPath: join(agentDir, EXPORT_NOTES_FILENAME),
      notes: plan.notes,
    };
  }

  private async scaffoldRuntimeResources(outputPath: string, input: RuntimeResourceConfig) {
    const resolver = getRuntimeTemplateResolver(
      { assetSource: this.assetSource, templateRenderer: this.templateRenderer },
      input,
    );
    if (!resolver)
      throw new InputValidationError(`unable to find template that matches given parameters`);

    const result = await resolver.resolve(input);
    await result.tree.write(dirname(outputPath));
    return { spec: result.spec, envEntries: result.envEntries ?? [] };
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
    const fileExists = existsSync(targetsPath);
    const targets = await this.listTargets(project);

    let target = targets.find((candidate) => candidate.name === input.target);

    // A freshly created project defines no targets, so the default one is
    // synthesized from the environment rather than demanded up front. Only
    // `default` gets this treatment: inventing a *named* target would turn a
    // typo'd --target into a deployment somewhere unintended.
    if (!target && input.target === DEFAULT_TARGET_NAME) {
      target = await this.provisionDefaultTarget(project, targetsPath, input.region);
      yield {
        type: "step",
        message:
          `Created default deployment target: account ${target.account}, ` +
          `region ${target.region} (${join("agentcore", "aws-targets.json")})`,
      };
    }

    if (!target) {
      if (!fileExists) {
        throw new ProjectStateError(
          `No deployment targets are configured for project '${project.name}'. ` +
            `Add ${targetsPath}, for example:\n\n${TARGETS_EXAMPLE}`,
        );
      }
      if (targets.length === 0) {
        throw new ProjectStateError(
          `No deployment targets are configured for project '${project.name}'. ` +
            `Add at least one to ${targetsPath}, for example:\n\n${TARGETS_EXAMPLE}`,
        );
      }
      throw new ProjectStateError(
        `Project '${project.name}' has no deployment target named '${input.target}'. ` +
          `${targetsPath} defines: ${targets.map(({ name }) => name).join(", ")}.`,
      );
    }

    // China (aws-cn) targets cannot run runtimes whose scaffolded code is
    // wired to Bedrock/Anthropic/OpenAI/Gemini (unreachable there), nor
    // harnesses (not part of the China launch). Runtimes without a persisted
    // modelProvider (BYO, provider-free, hand-edited, or scaffolded by an
    // older CLI) cannot be classified and only get an informational note.
    if (isChinaRegion(target.region)) {
      const bmaRuntimes = project.spec.runtimes.filter(isBmaRuntime);
      if (bmaRuntimes.length > 0) {
        throw new RegionUnsupportedFeatureError(
          `Cannot deploy to China region ${target.region}: ` +
            `${bmaRuntimes.map((runtime) => `runtime '${runtime.name}'`).join(", ")} uses ` +
            `Bedrock Managed Agents. ${BMA_CN_MESSAGE}`,
        );
      }
      const blocked = project.spec.runtimes.filter((runtime) => {
        if (runtime.modelProvider === undefined) return false;
        // LiteLLM's 'bedrock/' model id prefix routes to Amazon Bedrock —
        // the default when a runtime was scaffolded without --model-id.
        if (runtime.modelProvider === "LiteLLM") return runtime.modelId?.startsWith("bedrock/");
        // OpenAICompatible calls the endpoint the user chose, not api.openai.com.
        if (runtime.modelProvider === "OpenAICompatible") return false;
        return true;
      });
      if (blocked.length > 0) {
        throw new RegionUnsupportedFeatureError(
          `Cannot deploy to China region ${target.region}: ` +
            blocked
              .map(
                (runtime) =>
                  `runtime '${runtime.name}' (${runtime.modelProvider}${
                    runtime.modelProvider === "LiteLLM" ? ` → ${runtime.modelId}` : ""
                  })`,
              )
              .join(", ") +
            ` scaffolded with a model provider that is not accessible from China regions. ` +
            `Re-scaffold with '--model-provider litellm --model-id <model reachable from China>' ` +
            `or '--model-provider openai_compatible --api-base <OpenAI-compatible endpoint> ` +
            `--model-id <model>', ` +
            `or bring your own model connectivity. If you have already replaced a runtime's ` +
            `model wiring in code, delete its 'modelProvider' field from agentcore.json.`,
        );
      }
      if (project.spec.harnesses.length > 0) {
        throw new RegionUnsupportedFeatureError(HARNESS_CN_MESSAGE);
      }
      // Any non-empty spec collection outside the China allowlist fails here
      // with a clear message instead of CloudFormation's opaque "Unrecognized
      // resource types" — including collections added to the spec in the
      // future, which default to blocked until confirmed available there.
      const present = Object.entries(project.spec).filter(
        ([key, value]) =>
          Array.isArray(value) && value.length > 0 && !CN_SUPPORTED_SPEC_COLLECTIONS.has(key),
      );
      if (present.length > 0) {
        throw new RegionUnsupportedFeatureError(
          `Cannot deploy to China region ${target.region}: ` +
            present.map(([name]) => `'${name}'`).join(", ") +
            ` in agentcore.json ${present.length === 1 ? "is" : "are"} not available in China ` +
            `regions (cn-north-1, cn-northwest-1). Remove ${
              present.length === 1 ? "this entry" : "these entries"
            } before deploying to a China target.`,
        );
      }
      const unclassified = project.spec.runtimes.filter(
        (runtime) =>
          runtime.modelProvider === undefined ||
          // A LiteLLM runtime without a persisted model id (older CLI or
          // hand-edited spec) cannot be classified by routing.
          (runtime.modelProvider === "LiteLLM" && runtime.modelId === undefined),
      );
      if (unclassified.length > 0) {
        yield {
          type: "step",
          message:
            `Note: cannot verify the model provider of ` +
            unclassified.map((runtime) => `'${runtime.name}'`).join(", ") +
            `; Bedrock, Anthropic, OpenAI, and Gemini connectivity does not work in China regions.`,
        };
      }
    }

    return yield* this.backendFor(project).deploy(project, {
      target,
      confirmTeardown: input.confirmTeardown,
      transactionSearch: input.transactionSearch,
    });
  }

  // A read-only lookup, so callers (e.g. the deploy handler's up-front teardown
  // confirmation) can name the target's account and region without triggering
  // the default-target provisioning deploy performs.
  public async listTargets(project: Project): Promise<AwsDeploymentTarget[]> {
    const targetsPath = join(project.rootPath, "agentcore", "aws-targets.json");
    if (!existsSync(targetsPath)) return [];
    return this.json.read(targetsPath, AwsDeploymentTargetsSchema);
  }

  public async resolveTarget(
    project: Project,
    input: ResolveTargetInput,
  ): Promise<AwsDeploymentTarget | undefined> {
    const targets = await this.listTargets(project);
    return targets.find((candidate) => candidate.name === input.target);
  }

  public async resolveDeployedResource(
    project: Project,
    input: ResolveDeployedResourceInput,
  ): Promise<ResolvedDeployedResource> {
    const resolved = await this.resolveDeployedResources(project, { target: input.target });
    const resource = resolved.resources.find(
      ({ resourceType, name }) => resourceType === input.resourceType && name === input.name,
    );
    // The declared target wins over the copy on the item: the manager resolved it
    // from aws-targets.json, and the invoke, log, and traces handlers pin the AWS
    // region from this value while reusing the backend's verified credential
    // provider. Trusting a backend's target echo would let it redirect the call.
    if (resource) return { ...resource, target: resolved.target };

    const label = RESOURCE_LABELS[input.resourceType];
    throw new ProjectStateError(
      `${label} '${input.name}' is not deployed to target '${input.target}'. ` +
        `Run 'agentcore deploy --target ${input.target}' first.`,
    );
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesInput,
  ): Promise<ResolvedDeployedResources> {
    const target = await this.resolveExistingTarget(project, input.target);
    const resources = await this.backendFor(project).resolveDeployedResources(project, { target });
    return { resources, target };
  }

  public async resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesInput,
  ): Promise<ResolvedProjectResources> {
    const target = await this.resolveExistingTarget(project, input.target);
    const resources = await this.backendFor(project).resolveProjectResources(project, { target });
    return { resources, target };
  }

  private async resolveExistingTarget(
    project: Project,
    name: string,
  ): Promise<AwsDeploymentTarget> {
    const targetsPath = join(project.rootPath, "agentcore", "aws-targets.json");
    const targets = existsSync(targetsPath)
      ? await this.json.read(targetsPath, AwsDeploymentTargetsSchema)
      : [];
    if (targets.length === 0) {
      throw new ProjectStateError(
        `No deployment targets are configured for project '${project.name}'. ` +
          `Please deploy your project using 'agentcore deploy'.`,
      );
    }

    const target = targets.find((candidate) => candidate.name === name);
    if (!target) {
      throw new ProjectStateError(
        `Project '${project.name}' has no deployment target named '${name}'. ` +
          `${targetsPath} defines: ${targets.map(({ name }) => name).join(", ")}.`,
      );
    }

    return target;
  }

  /**
   * Builds the default deployment target from the environment — the active
   * credentials' account and the CLI's effective region — and persists it to
   * aws-targets.json alongside any targets already defined there.
   */
  private async provisionDefaultTarget(
    project: Project,
    targetsPath: string,
    region: string,
  ): Promise<AwsDeploymentTarget> {
    const supportedRegion = AgentCoreRegionSchema.safeParse(region);
    if (!supportedRegion.success) {
      throw new InputValidationError(
        `Cannot create the default deployment target for project '${project.name}': ` +
          `'${region}' is not an AgentCore-supported region.\n` +
          `Supported regions: ${AgentCoreRegionSchema.options.join(", ")}.\n` +
          `Re-run with --region <region> or set AWS_REGION to one of them.`,
      );
    }

    let account: string;
    try {
      account = await this.resolveAccount(supportedRegion.data);
    } catch (error) {
      const cause = AgentCoreCLIError.fromError(error);
      throw new InvalidEnvironmentError(
        `Cannot create the default deployment target for project '${project.name}' because ` +
          `the AWS account could not be resolved: ${cause.message}\n` +
          `Check that valid AWS credentials are configured (for example via 'aws configure', ` +
          `AWS_PROFILE, or environment variables) and re-run 'agentcore deploy'.`,
        { cause: error },
      );
    }

    const entry = AwsDeploymentTargetSchema.safeParse({
      name: DEFAULT_TARGET_NAME,
      account,
      region: supportedRegion.data,
    });
    if (!entry.success) {
      throw new MalformedServiceResponseError(
        `STS returned an AWS account ID that is not usable as a deployment target:\n` +
          z.prettifyError(entry.error),
        { cause: entry.error },
      );
    }

    // Merged into the raw file contents rather than the schema-parsed targets,
    // so existing entries keep their exact key order and any fields the schema
    // does not know about.
    const existing = existsSync(targetsPath)
      ? await this.json.read(targetsPath, z.array(z.record(z.string(), z.unknown())))
      : [];
    await this.json.write(targetsPath, [...existing, entry.data]);
    return entry.data;
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

  private async checkCreateDependencies(input: CreateProjectInput): Promise<void> {
    if (!input.skipInstall) {
      await this.checkTool("npm", NODE_INSTALL_HINT);
      if (
        input.scaffoldRuntimeInput?.language === "Python" &&
        templateManagesDependencies(resolveRuntimeTemplateProfile(input.scaffoldRuntimeInput))
      ) {
        await this.checkTool("uv", UV_INSTALL_HINT);
      }
    }
    if (!input.skipGit) {
      await this.checkTool("git", GIT_INSTALL_HINT);
    }
  }

  private async checkRuntimeDependency(
    input: RuntimeResourceConfig["scaffoldRuntimeInput"],
  ): Promise<void> {
    if (!templateManagesDependencies(resolveRuntimeTemplateProfile(input))) return;
    if (input.language === "Python") {
      await this.checkTool("uv", UV_INSTALL_HINT);
    } else {
      await this.checkTool("npm", NODE_INSTALL_HINT);
    }
  }

  /**
   * Installs dependencies for a scaffolded runtime directory (e.g. `uv sync`
   * for Python). No-ops if the runtime has no recognized dependency manifest.
   */
  private async *installRuntimeDependencies(
    appDir: string,
    input?: RuntimeResourceConfig["scaffoldRuntimeInput"],
  ): AsyncGenerator<ProjectEvent, void> {
    if (input && !templateManagesDependencies(resolveRuntimeTemplateProfile(input))) return;
    if (existsSync(join(appDir, "pyproject.toml"))) {
      await this.checkTool("uv", UV_INSTALL_HINT);
      yield { type: "step", message: "Syncing Python dependencies with uv" };
      yield* this.run(["uv", "sync"], appDir);
    } else if (existsSync(join(appDir, "package.json"))) {
      await this.checkTool("npm", NODE_INSTALL_HINT);
      yield { type: "step", message: "Installing Node dependencies with npm" };
      yield* this.run(NPM_INSTALL, appDir, npmProgressLine);
    }
  }

  /** Generates the container build's lockfile (uv.lock / package-lock.json) when its manifest exists but the lockfile does not. */
  private async *ensureLockFileExists(appDir: string): AsyncGenerator<ProjectEvent, void> {
    const lockfileSpecs = [
      { manifest: "pyproject.toml", lockfile: "uv.lock", command: ["uv", "lock"] },
      {
        manifest: "package.json",
        lockfile: "package-lock.json",
        command: ["npm", "install", "--package-lock-only"],
      },
    ];
    for (const { manifest, lockfile, command } of lockfileSpecs) {
      if (!existsSync(join(appDir, manifest)) || existsSync(join(appDir, lockfile))) {
        continue;
      }
      yield { type: "step", message: `Generating ${lockfile} for container build` };
      try {
        yield* this.run(command, appDir);
      } catch {
        yield {
          type: "step",
          message:
            `Warning: could not generate ${lockfile} in ${appDir}. ` +
            `Run \`${command.join(" ")}\` there before \`agentcore dev\` or \`deploy\` — ` +
            "container builds install from it.",
        };
      }
      return;
    }
  }

  /**
   * Runs a command, yielding its output as `output` events so a progress driver can show a live tail
   * under the running step. The debug log gets each chunk whole; the splitter reassembles them into
   * lines for display, and `formatLine` may rewrite or drop a line before it is shown.
   */
  private async *run(
    command: string[],
    cwd: string,
    formatLine: (line: string) => string | undefined = (line) => line,
  ): AsyncGenerator<ProjectEvent, void, unknown> {
    yield* withOutputEvents((emit) => {
      const lines = createLineSplitter((line) => {
        const formatted = formatLine(line);
        if (formatted !== undefined) emit(formatted);
      });
      return this.runner(command, {
        cwd,
        onOutput: (chunk) => {
          this.logger.debug(chunk);
          lines.push(chunk);
        },
      }).finally(() => lines.flush());
    });
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
    case "evaluator":
      return "evaluators";
    case "gateway":
    case "gateway-target":
      return "agentCoreGateways";
    case "policy-engine":
    case "policy":
      return "policyEngines";
    case "payment-manager":
    case "payment-connector":
      return "payments";
    case "runtime-endpoint":
      return "runtimes";
  }
}

/** The strands-agents requirement from the rendered pyproject.toml, for EXPORT_NOTES.md. */
async function readStrandsVersion(agentDir: string): Promise<string> {
  try {
    const pyproject = await readFile(join(agentDir, "pyproject.toml"), "utf-8");
    const match = /strands-agents(?:\[[^\]]+\])?\s*([~><=]+\s*[\d.]+)/.exec(pyproject);
    return match ? `strands-agents ${match[1]}` : "strands-agents (version unknown)";
  } catch {
    return "strands-agents (version unknown)";
  }
}

function parseResource<TSchema extends z.ZodType>(
  schema: TSchema,
  input: z.input<TSchema>,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  return result.data;
}
