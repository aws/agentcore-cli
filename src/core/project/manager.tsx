import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import semver from "semver";
import type {
  AddResourceOptions,
  AddResourceInput,
  CreateProjectInput,
  BuildProjectInput,
  DeployProjectInput,
  DeployResult,
  EnvLocalEntry,
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
  SyncRuntimeBuildsInput,
  SyncRuntimeBuildsResult,
  RemoveResourceInput,
  RemoveResourceResult,
  RemovedGateway,
  RemoveResourcesResult,
  ScaffoldRuntimeInput,
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
import {
  HARNESS_API_KEY_PROVIDER_LABELS,
  getHarnessTemplateResolver,
  harnessApiKeyCredentialName,
  validateHarnessTemplateSource,
} from "./templates/harness";
import { boxGatewayIamWarnings, type BoxNetwork } from "./boxNetwork";
import { reservedBoxTargetNameProblem } from "./boxMemory";
import { boxNetworkFailureMessage, readBoxNetworks } from "./boxNetworkSource";
import { resolveRegion } from "../region";
import { BoxCliProfileResolver, type BoxProfileResolver } from "./boxProfileResolver";
import {
  addBoxGatewaysToRecord,
  BOX_GATEWAY_TARGETS_FILE,
  FS_RECORD_FILES,
  readBoxGatewayTargets,
  removeBoxGatewaysFromRecord,
  replaceRecord,
  type RecordFiles,
  type RestoreRecord,
} from "./boxGatewayTargets";
import {
  BOX_NETWORK_WRITERS,
  boxKeyReads,
  boxNetworkEdits,
  writeBoxNetworkFiles,
  type BoxNetworkFile,
} from "./boxNetworkWriters";
import { boxCodeZipFiles, createProjectTree } from "./templates/project";
import {
  BOX_CODEZIP_ENTRYPOINT,
  boxAgentDir,
  boxAwsDir,
  boxLocalMetadataPolicyPath,
  boxLocalProfileFile,
  boxLocalProfilePath,
  boxProfileWarnings,
  boxUvSyncEnv,
  hasBoxProfile,
  observabilityOff,
  renderAwsMetadataPolicy,
  renderBoxProfile,
  runsInBox,
  runtimeRunsInBox,
  startsInBoxOnCodeZip,
} from "./templates/boxProfile";
import { defaultLogTargetNotice } from "./runtimeProfile/rules/additions";
import { assertRuntimeV2RegionSupported, validateBoxRuntimes } from "./boxValidation";
import { BOX_INSTALL_HINT, BOX_RELEASE } from "./backends/boxRelease";
import { getRuntimeTemplateResolver } from "./templates/runtime";
import {
  EXPORT_NOTES_FILENAME,
  buildExportNotesMarkdown,
  mapHarnessToExportPlan,
} from "./templates/export";
import { HarnessSpecSchema, HarnessYamlSchema } from "../../projectSchemas/harness";
import { FsTreeNode } from "./templates/fsTree";
import { getEvaluatorTemplateResolver } from "./templates/evaluator";
import {
  boxGatewayName,
  boxGatewaySpec,
  isBoundGateway,
  isBoxProject,
  isBuildOwnedTarget,
  ProjectSpecSchema,
  type ManagedBy,
} from "../../projectSchemas/project";
import { ConfigBundleSchema } from "../../projectSchemas/config-bundle";
import { MAX_TAGS, TEMPLATE_TAG_KEY } from "../../projectSchemas/tags";
import {
  type AgentCoreGateway,
  AgentCoreGatewaySchema,
  type AgentCoreGatewayTarget,
} from "../../projectSchemas/gateway";
import {
  CredentialSchema,
  credentialEnvVarName,
  credentialEnvironmentVariableNames,
} from "../../projectSchemas/credential";
import { MemorySchema } from "../../projectSchemas/memory";
import { EvaluatorSchema } from "../../projectSchemas/evaluator";
import { OnlineEvalConfigSchema } from "../../projectSchemas/online-eval-config";
import { PaymentConnectorSchema, PaymentManagerSchema } from "../../projectSchemas/payment";
import { PolicyEngineSchema, PolicySchema } from "../../projectSchemas/policy";
import { BOX_PLATFORM_VERSION, RuntimeEndpointSchema } from "../../projectSchemas/runtime";
import { defaultExportProjectName, enclosingProjectRoot, projectSpecPath } from "./fsUtils";
import { parseArn } from "../arn";
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
import {
  cdkAcceptsPassthroughGateway,
  type PassthroughGatewayCheck,
} from "./backends/cdk/compatibility";
import {
  customJwtGatewayNotice,
  gatewayList,
  reachedGatewayNames,
  uncheckedBecause,
} from "./boxNetwork/projectGateways";
import { resolveAwsAccount } from "./backends/cdk/environment";
import { pinnedVersion } from "./backends/cdk/dependencies";
import type { ProjectBackend } from "./backends/types";
import {
  AwsDeploymentTargetSchema,
  AwsDeploymentTargetsSchema,
  DEFAULT_TARGET_NAME,
  type AwsDeploymentTarget,
} from "../../projectSchemas/aws-targets";
import { V0AwsDeploymentTargetsSchema } from "../../projectSchemas/v0";
import {
  isRuntimeDocsConfig,
  type RuntimeDocsConfig,
  type RuntimeResourceConfig,
} from "../../handlers/project/add/runtime/types";
import { buildDocsRuntimeSpec, runtimeDocsTree } from "./templates/runtimeDocs";
import type { TemplateRenderer } from "./templates/types";
import { HandlebarsTemplateRenderer } from "./templates/renderer";
import type { CreateCloudFormationClient } from "../types";
import type { CoreIdentityClient } from "../../handlers/identity/types";
import { templateManagesDependencies } from "../../handlers/project/templateProfile";
import { resolveRuntimeTemplateProfile } from "../../handlers/project/runtimeTemplateProfile";
import { projectFormat, type ProjectFormat } from "./legacy/detect";
import { loadLegacyProject } from "./legacy/load";
import { assertV1Project } from "./legacy/writeGate";
import { assertNoPendingMigration } from "./migrate/journal";
import { LATEST_PYTHON, prepareRuntimes } from "./runtimeBuild";
import { isContainerBuild } from "../../projectSchemas/constants";
import { resolveWorkloads } from "./backends/cdk/localContainers";

const TARGETS_EXAMPLE = '[{ "name": "default", "account": "111122223333", "region": "us-east-1" }]';

const NODE_INSTALL_HINT = "Install Node.js: https://nodejs.org/";
const UV_INSTALL_HINT = "Install uv: https://docs.astral.sh/uv/getting-started/installation/";
// v0.24.2 introduced dependency syncing with this exact CDK pin.
const MINIMUM_V0_CDK_VERSION = "0.1.0-alpha.45";

interface CdkDependency {
  /** As written in package.json, trimmed. */
  spec: string;
  version: string;
}

function v0DependencyWarning(dependency: CdkDependency | undefined): string | undefined {
  if (!dependency || !semver.lt(dependency.version, MINIMUM_V0_CDK_VERSION)) return undefined;
  return (
    "This project's CDK dependencies are older than v0.24.2. " +
    "Run `npx @aws/agentcore@0 deploy` once to update them, then try again."
  );
}

/** Rejects a project whose agentcore.json format and vended CDK library major disagree. */
function assertCdkLibraryMatches(
  format: ProjectFormat,
  dependency: CdkDependency | undefined,
  cause?: unknown,
): void {
  if (!dependency) return;
  const library: ProjectFormat = semver.major(dependency.version) >= 1 ? "v1" : "v0";
  if (library === format) return;

  const declared = `@aws/agentcore-cdk ${dependency.spec}`;
  throw new ProjectStateError(
    format === "v1"
      ? "agentcore/agentcore.json says this is a v1 project (version 2), but its CDK library is " +
          `v0 (${declared}). Set "version" back to 1, or run \`agentcore migrate\` to upgrade it.`
      : "agentcore/agentcore.json says this is a v0 project (version 1), but its CDK library is " +
          `v1 (${declared}). Set "version" to 2, or reinstall the v0 CDK app.`,
    { cause },
  );
}

/**

 * Shown when a runtime template hardwired to an unreachable model provider
 * targets a China (aws-cn) region and takes no --model-provider override
 * (langchain, vercel, a Bedrock Agent import). Amazon Bedrock, Anthropic, OpenAI, and
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
 * What an `add` adds, as the China gate classifies it: the resource type,
 * except that a connector-backed Gateway Target is its own kind, since it is
 * refused where other Gateway Targets are allowed.
 */
export type ChinaAddKind = AddResourceInput["resourceType"] | "gateway-connector";

/**
 * The `add` kinds available in China regions — the families whose
 * CloudFormation types ARE registered there (verified against cn-north-1's
 * public registry): Runtime, RuntimeEndpoint, Gateway (+Target/+RateLimit), and
 * Identity credentials. The single source for the add gate below, for the
 * "(not available in China regions)" note on each `add` subcommand's help, and
 * for the add menu's China alert. Declared as an allowlist so any kind added
 * later is blocked in China, and says so in its help, until its availability
 * there is confirmed and it is added here.
 */
const CN_SUPPORTED_ADD_KINDS: ReadonlySet<ChinaAddKind> = new Set<ChinaAddKind>([
  "runtime",
  "runtime-endpoint",
  "credential",
  "gateway",
  "gateway-target",
]);

/** The China kind of an `add` input (see {@link ChinaAddKind}). */
export function chinaAddKind(input: AddResourceInput): ChinaAddKind {
  return input.resourceType === "gateway-target" && input.resourceConfig.targetType === "connector"
    ? "gateway-connector"
    : input.resourceType;
}

/** Whether an `add` kind can be added to, and deployed from, a project with a China target. */
export function isAddableInChina(kind: ChinaAddKind): boolean {
  return CN_SUPPORTED_ADD_KINDS.has(kind);
}

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

/**
 * Shown when a Gateway Target of type `connector` is added to, or deployed from, a
 * project with a China (aws-cn) target. The curated connectors are a static CLI
 * list, not a regional catalog: `bedrock-knowledge-bases` needs Amazon Bedrock,
 * which is not available there, and `web-search` has never been confirmed in
 * China, so both stay blocked until the Gateway service confirms them.
 */
export function cnConnectorTargetMessage(connectorId: string | undefined): string {
  const connector = connectorId ?? "unknown";
  return (
    `Gateway connector targets are not available in China regions (cn-north-1, cn-northwest-1): ` +
    `the '${connector}' connector cannot be used there` +
    (connector === "bedrock-knowledge-bases"
      ? ", and Amazon Bedrock Knowledge Bases are not available in China"
      : "") +
    `. Add a Runtime-backed or MCP-server Target instead.`
  );
}

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
  /** How the record of build's targets is written; the file on disk by default. */
  recordFiles?: RecordFiles;
  /**
   * The environment the CDK backend reads HOME (the box cache) from, and build reads box `env://`
   * egress secrets from; process.env by default.
   */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Resolves the box profile as Box does, for build and deploy to read its network; the `box` on
   * PATH by default.
   */
  boxProfileResolver?: BoxProfileResolver;
  /**
   * Whether the @aws/agentcore-cdk of the CDK app in a folder accepts a passthrough target with
   * `gateway`; build writes such a target only then. `cdkAcceptsPassthroughGateway` by default.
   */
  cdkAcceptsPassthroughGateway?: (cdkDirectory: string) => Promise<PassthroughGatewayCheck>;
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
  private readonly recordFiles: RecordFiles;
  private readonly backends: Partial<Record<ManagedBy, ProjectBackend>>;
  private readonly resolveAccount: (region: string) => Promise<string>;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly boxProfileResolver: BoxProfileResolver;
  private readonly cdkAcceptsPassthroughGateway: (
    cdkDirectory: string,
  ) => Promise<PassthroughGatewayCheck>;

  constructor(config: ProjectManagerConfig) {
    this.logger = config.logger;
    this.assetSource = config.source ?? defaultSource();
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.recordFiles = config.recordFiles ?? FS_RECORD_FILES;
    this.backends = config.backends ?? {
      CDK: new CdkBackend({
        logger: config.logger,
        createCloudFormationClient: config.createCloudFormationClient,
        identity: config.identity,
        enableTransactionSearch: config.enableTransactionSearch,
        runner: config.runner,
        checkTool: config.checkTool,
        json: config.json,
        processEnv: config.processEnv,
        source: this.assetSource,
      }),
    };
    this.templateRenderer = config.templateRenderer ?? new HandlebarsTemplateRenderer();
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.processEnv = config.processEnv ?? process.env;
    this.boxProfileResolver =
      config.boxProfileResolver ?? new BoxCliProfileResolver({ env: this.processEnv });
    this.cdkAcceptsPassthroughGateway =
      config.cdkAcceptsPassthroughGateway ?? cdkAcceptsPassthroughGateway;
  }

  public async resolve(input: ResolveProjectInput): Promise<Project | undefined> {
    const rootPath = enclosingProjectRoot(input.filePath);
    if (!rootPath) return undefined;

    const configPath = projectSpecPath(rootPath);
    const cdkDependency = await this.declaredCdkDependency(rootPath);
    try {
      const spec = await this.json.read(configPath, ProjectSpecSchema);
      assertCdkLibraryMatches("v1", cdkDependency);
      return {
        name: spec.name,
        rootPath,
        spec,
      };
    } catch (error) {
      if (error instanceof DeserializationError) {
        const header = await this.json
          .read(configPath, z.object({ version: z.unknown().optional() }))
          .catch(() => undefined);
        if (projectFormat(header) === "v0") {
          const warning = v0DependencyWarning(cdkDependency);
          if (warning) throw new ProjectStateError(warning, { cause: error });
          assertCdkLibraryMatches("v0", cdkDependency, error);
          return loadLegacyProject(rootPath, this.json);
        }
        // An invalid v1 spec on a v0 CDK app is almost always a hand-bumped version.
        if (header?.version === 2) assertCdkLibraryMatches("v1", cdkDependency, error);
      }
      throw error;
    }
  }

  /** The `@aws/agentcore-cdk` dependency the vended CDK app declares, if it is a plain semver. */
  private async declaredCdkDependency(rootPath: string): Promise<CdkDependency | undefined> {
    const manifest = await this.json
      .read(
        join(rootPath, "agentcore", "cdk", "package.json"),
        z.object({ dependencies: z.record(z.string(), z.unknown()).optional() }),
      )
      .catch(() => undefined);
    const declared = manifest?.dependencies?.["@aws/agentcore-cdk"];
    if (typeof declared !== "string") return undefined;

    const version = pinnedVersion(declared)?.version;
    return version ? { spec: declared.trim(), version } : undefined;
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
    if (input.scaffoldHarnessInput) {
      validateHarnessTemplateSource(input.scaffoldHarnessInput, destination);
    }

    const scaffoldRuntimeInput = input.scaffoldRuntimeInput;

    const { tree: projectTree, envEntries } = await createProjectTree(
      { templateRenderer: this.templateRenderer, assetSource: this.assetSource },
      { projectName: input.name, privateVpc: input.containment === "private-vpc" },
      { runtime: scaffoldRuntimeInput, importBedrockAgent: input.importBedrockAgent },
    );

    // Validate required tools exist before starting creation flow
    await this.checkCreateDependencies(input);

    yield { type: "step", message: "creating project tree" };
    await projectTree.write(destination);

    if (envEntries.length > 0) {
      yield { type: "step", message: "writing model provider API key to agentcore/.env.local" };
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
        apiKey: input.harnessApiKey,
      });
    }

    // A failed step leaves the scaffolded files in place; the error carries the
    // failing command, its directory, and its output.
    if (!input.skipInstall) {
      yield { type: "step", message: "installing CDK dependencies with npm" };
      yield* this.run(NPM_INSTALL, join(destination, "agentcore", "cdk"), npmProgressLine);

      if (scaffoldRuntimeInput) {
        const appDir = join(destination, "app", scaffoldRuntimeInput.runtimeName);
        yield* this.installRuntimeDependencies(appDir, scaffoldRuntimeInput);
      }
    } else if (
      scaffoldRuntimeInput !== undefined &&
      isContainerBuild({ build: scaffoldRuntimeInput.build }) &&
      templateManagesDependencies(resolveRuntimeTemplateProfile(scaffoldRuntimeInput))
    ) {
      // Container builds install from a lockfile, so generate it even with no-install.
      const appDir = join(destination, "app", scaffoldRuntimeInput.runtimeName);
      yield* this.ensureLockFileExists(appDir);
    }
    if (scaffoldRuntimeInput) {
      // Both create paths pass the region they resolved; without one, create resolves it as
      // --region does with no flag.
      yield* this.writeBoxProfile(
        destination,
        input.name,
        scaffoldRuntimeInput,
        input.region ?? (await resolveRegion(undefined, this.processEnv)),
      );
    }

    if (!input.skipGit) {
      yield { type: "step", message: "initializing git repository" };
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
    yield* defaultLogTargetNotices(project.spec, project.spec.runtimes);
    if (isBoxProject(project.spec)) yield* boxGatewayLogsWarnings(project.spec.agentCoreGateways);
    return project;
  }

  /**
   * Whether `add`-time China (aws-cn) restrictions apply: a deployment target
   * is in a China region, or no target exists yet and the CLI's resolved region
   * (what deploy would make the default target) is one. See {@link AddResourceOptions}.
   */
  private async isChinaProject(project: Project, region: string | undefined): Promise<boolean> {
    const targets = await this.listTargets(project);
    if (targets.length > 0) return targets.some((target) => isChinaRegion(target.region));
    return region !== undefined && isChinaRegion(region);
  }

  public async *addResource(
    project: Project,
    input: AddResourceInput,
    options: AddResourceOptions = {},
  ): AsyncGenerator<ProjectEvent, Project> {
    assertV1Project(project, "add");
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const projectSpecKey = toProjectSpecKey(input.resourceType);

    yield { type: "step", message: `reading project spec file at '${agentCoreSpecPath}'` };
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
      // Build owns some target names on the Box gateway of a boxed runtime.
      const parent = projectSpec.agentCoreGateways.find(
        (candidate) => candidate.name === input.gatewayName,
      );
      const reserved =
        parent && reservedBoxTargetNameProblem(projectSpec, parent, input.resourceConfig.name);
      if (reserved) throw new InputValidationError(reserved);
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
    // kinds in CN_SUPPORTED_ADD_KINDS (Runtime, Gateway, credential). Runtimes additionally gate on the model provider
    // — Bedrock/Anthropic/OpenAI/Gemini are unreachable, LiteLLM needs an
    // explicit model id (its default routes to Bedrock) — and the default
    // memory is dropped from the scaffold (see MEMORY_STRIPPED_CN_MESSAGE);
    // provider-free scaffolds (framework "none": minimal, MCP) stay available
    // as the bring-your-own-implementation path.
    //
    // Before the first deploy a project has no target, so the resolved region
    // stands in — the same region deploy synthesizes the default target from.
    // A defined target always wins over the ambient region.
    if (await this.isChinaProject(project, options.region)) {
      if (input.resourceType === "harness") {
        throw new RegionUnsupportedFeatureError(HARNESS_CN_MESSAGE);
      }
      // One allowlist decides what is refused (CN_SUPPORTED_ADD_KINDS); the
      // input decides which message: a connector-backed Gateway Target gets
      // its own, every other blocked kind the generic one.
      if (!isAddableInChina(chinaAddKind(input))) {
        throw new RegionUnsupportedFeatureError(
          input.resourceType === "gateway-target" && input.resourceConfig.targetType === "connector"
            ? cnConnectorTargetMessage(input.resourceConfig.connectorId)
            : cnUnsupportedResourceMessage(input.resourceType),
        );
      }
      // A docs-only runtime has no scaffolded code to gate; its code is the user's.
      if (input.resourceType === "runtime" && !isRuntimeDocsConfig(input.resourceConfig)) {
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
        const harnessName = input.resourceConfig.name;
        const model = input.resourceConfig.model;
        let resourceConfig = input.resourceConfig;
        // A managed API key is stored the way a runtime's is: a project
        // credential the model names, its secret in .env.local, provisioned
        // on deploy before synth resolves the name to its ARN.
        let harnessEnvEntries: EnvLocalEntry[] = [];
        if (input.apiKey !== undefined) {
          if (model.provider === "bedrock") {
            throw new InputValidationError(
              'an API key is not supported for the "bedrock" model provider; Bedrock uses the harness role',
            );
          }
          if (model.apiKeyArn !== undefined) {
            throw new InputValidationError(
              "an API key cannot be combined with the model's apiKeyArn; give one or the other",
            );
          }
          const credentialName = harnessApiKeyCredentialName(harnessName, model.provider);
          resourceConfig = {
            ...resourceConfig,
            model: { ...model, apiKeyCredentialName: credentialName },
          };
          if (!projectSpec.credentials.some((credential) => credential.name === credentialName)) {
            projectSpec.credentials.push({
              authorizerType: "ApiKeyCredentialProvider",
              name: credentialName,
            });
          }
          harnessEnvEntries = [
            {
              key: credentialEnvVarName(credentialName),
              value: input.apiKey,
              comment: `API key for the ${HARNESS_API_KEY_PROVIDER_LABELS[model.provider]} model provider (harness ${harnessName})`,
            },
          ];
        }
        const credentialName = resourceConfig.model.apiKeyCredentialName;
        if (credentialName !== undefined) {
          const credential = projectSpec.credentials.find(
            (candidate) => candidate.name === credentialName,
          );
          if (!credential) {
            throw new ResourceNotFoundError(
              `no credential named '${credentialName}' exists in this project`,
            );
          }
          if (credential.authorizerType !== "ApiKeyCredentialProvider") {
            throw new InputValidationError(
              `credential '${credentialName}' is a ${credential.authorizerType}, not an ApiKeyCredentialProvider`,
            );
          }
        }

        yield { type: "step", message: `scaffolding harness in project` };
        const outputPath = join(project.rootPath, "app", harnessName);
        // Rollback removes only what this add created, never a folder the user already had.
        if (!existsSync(outputPath)) scaffoldedPaths.push(outputPath);

        const resolver = getHarnessTemplateResolver({
          projectRoot: project.rootPath,
          assetSource: this.assetSource,
          templateRenderer: this.templateRenderer,
        });
        const result = await resolver.resolve(resourceConfig);
        await result.tree.write(dirname(outputPath));
        if (resourceConfig.dockerfile && !resourceConfig.buildContextPath) {
          yield {
            type: "step",
            message:
              `copied ${resourceConfig.dockerfile} to app/${harnessName}/Dockerfile; later ` +
              "edits to the original are not used",
          };
        }
        if (result.spec.harnesses) projectSpec.harnesses.push(...result.spec.harnesses);
        if (harnessEnvEntries.length > 0) {
          envFile = new EnvLocalFile(project.rootPath);
          yield { type: "step", message: `updating secrets file at '${envFile.path}'` };
          const { skipped } = await envFile.insertIfNew(harnessEnvEntries);
          for (const key of skipped) {
            yield {
              type: "step",
              message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
            };
          }
        }
        break;
      }
      case "runtime": {
        // Every runtime of a Box project runs in a box, so a runtime added to one gets what
        // create gives a box runtime, with its own box profile in .box/<name>/local/.
        const boxInput = isBoxProject(projectSpec)
          ? boxRuntimeInput(projectSpec, input.resourceConfig)
          : undefined;
        const outputPath = join(project.rootPath, "app", input.resourceConfig.name);
        // The folder may hold the user's own code, but never another resource's. A
        // pre-built runtime writes no files but still records app/<name> as its codeLocation.
        const owner = appFolderOwner(projectSpec, project.rootPath, outputPath);
        if (owner !== undefined) {
          throw new InputValidationError(
            `cannot add runtime '${input.resourceConfig.name}': 'app/${input.resourceConfig.name}' ` +
              `overlaps the files of ${owner}. Choose a different --name.`,
          );
        }
        if (boxInput) await this.assertNoOtherStartScript(outputPath, input.resourceConfig.name);
        if (
          isRuntimeDocsConfig(input.resourceConfig) &&
          input.resourceConfig.containerUri !== undefined
        ) {
          projectSpec.runtimes.push(buildDocsRuntimeSpec(input.resourceConfig));
          yield { type: "step", message: "configuring runtime from the existing ECR image" };
          break;
        }
        // Rollback removes only what this add created, never a folder the user already had.
        const folderExisted = existsSync(outputPath);
        if (isRuntimeDocsConfig(input.resourceConfig)) {
          const relativeFolder = `app/${input.resourceConfig.name}`;
          yield { type: "step", message: `writing runtime docs to '${relativeFolder}'` };
          const tree = await runtimeDocsTree(
            {
              assetSource: this.assetSource,
              templateRenderer: this.templateRenderer,
              projectRoot: project.rootPath,
            },
            input.resourceConfig,
          );
          // Tracked as each file is written, so a write that fails partway is
          // cleaned up too (only what this add created).
          const written: string[] = [];
          if (!folderExisted) scaffoldedPaths.push(outputPath);
          try {
            await tree.write(dirname(outputPath), { skipExisting: true, written });
          } catch (err) {
            await this.discardStaged(folderExisted ? written : [outputPath]);
            throw err;
          }
          if (folderExisted) scaffoldedPaths.push(...written);
          if (written.includes(join(outputPath, "Dockerfile"))) {
            yield {
              type: "step",
              message:
                `copied ${input.resourceConfig.dockerfile} to ${relativeFolder}/Dockerfile; ` +
                "later edits to the original are not used",
            };
          }
          for (const child of tree.children) {
            if (!written.includes(join(outputPath, child.name))) {
              yield {
                type: "step",
                message: `'${relativeFolder}/${child.name}' already exists; left unchanged`,
              };
            }
          }
          projectSpec.runtimes.push(buildDocsRuntimeSpec(input.resourceConfig));
          if (boxInput) {
            // A failure here comes before the spec write, whose catch removes what this add
            // created, so the box scaffold removes it itself.
            try {
              yield* this.addBoxRuntime(
                project.rootPath,
                projectSpec,
                boxInput,
                scaffoldedPaths,
                await resolveRegion(options.region, this.processEnv),
              );
            } catch (err) {
              await this.discardStaged(scaffoldedPaths);
              throw err;
            }
          }
          break;
        }

        await this.checkRuntimeDependency(input.resourceConfig.scaffoldRuntimeInput);
        yield { type: "step", message: "scaffolding runtime in project" };
        if (!folderExisted) scaffoldedPaths.push(outputPath);

        // Tracked as each file is written, so a failed write into an existing
        // folder removes only what it wrote, and a new folder goes entirely.
        const scaffoldWritten: string[] = [];
        const { spec, envEntries } = await this.scaffoldRuntimeResources(
          outputPath,
          input.resourceConfig,
          scaffoldWritten,
        ).catch(async (err: unknown) => {
          await this.discardStaged(folderExisted ? scaffoldWritten : [outputPath]);
          throw err;
        });
        if (folderExisted) scaffoldedPaths.push(...scaffoldWritten);
        if (spec.runtimes) projectSpec.runtimes.push(...spec.runtimes);
        if (spec.memories) projectSpec.memories.push(...spec.memories);
        if (spec.credentials) projectSpec.credentials.push(...spec.credentials);
        if (envEntries.length > 0) {
          envFile = new EnvLocalFile(project.rootPath);
          yield { type: "step", message: `updating secrets file at '${envFile.path}'` };
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
          yield { type: "step", message: `updating secrets file at '${envFile.path}'` };
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
      case "online-eval": {
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
          yield { type: "step", message: "scaffolding evaluator in project" };
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

    yield { type: "step", message: `updating project spec file at '${agentCoreSpecPath}'` };

    let newProjectSpec: z.infer<typeof ProjectSpecSchema>;
    let restoreRecord: RestoreRecord | undefined;
    try {
      const newSpecParseResult = ProjectSpecSchema.safeParse(projectSpec);
      if (!newSpecParseResult.success)
        throw new ProjectStateError(z.prettifyError(newSpecParseResult.error), {
          cause: newSpecParseResult.error,
        });
      // Build owns no target of a new Box gateway yet: an empty entry in the record says so. The
      // record changes first, and goes back when agentcore.json cannot take the gateway.
      if (input.resourceType === "runtime") {
        restoreRecord = addBoxGatewaysToRecord(
          project.rootPath,
          newSpecParseResult.data.agentCoreGateways.flatMap(({ name, boundRuntime }) =>
            boundRuntime === input.resourceConfig.name ? [name] : [],
          ),
          this.recordFiles,
        );
      }
      newProjectSpec = await this.json.write(agentCoreSpecPath, newSpecParseResult.data);
    } catch (err) {
      this.logger.warn(
        `could not commit the spec update to ${agentCoreSpecPath}; attempting best-effort cleanup of staged changes`,
      );
      this.restoreRecord(restoreRecord);
      await Promise.all([
        this.discardStaged(scaffoldedPaths),
        envFile?.rollback().catch((e) => {
          const error = AgentCoreCLIError.fromError(e);
          this.logger
            .child({ errorName: error.name, errorMessage: error.message })
            .warn(`failed to roll back ${ENV_LOCAL_RELATIVE_PATH}`);
        }),
      ]);
      throw err;
    }
    // After the write, so a failed write gives no notice for a gateway that was not written.
    if (input.resourceType === "gateway") {
      const added = newProjectSpec.agentCoreGateways.find(
        ({ name }) => name === input.resourceConfig.name,
      );
      const boxed = newProjectSpec.runtimes.some(
        (runtime) =>
          runtimeRunsInBox(newProjectSpec, runtime) && runtime.containment !== "PRIVATE_VPC",
      );
      if (added && !added.boundRuntime && added.authorizerType === "CUSTOM_JWT" && boxed) {
        yield { type: "warning", message: customJwtGatewayNotice(added.name) };
      }
    }
    // After the write, so a failed write gives no notice for a runtime that was not written.
    if (input.resourceType === "runtime") {
      const added = input.resourceConfig.name;
      yield* defaultLogTargetNotices(
        newProjectSpec,
        newProjectSpec.runtimes.filter(({ name }) => name === added),
      );
      const boxGateways = newProjectSpec.agentCoreGateways.filter(
        ({ boundRuntime }) => boundRuntime === added,
      );
      yield* boxGatewayLogsWarnings(boxGateways);
      if (restoreRecord) yield { type: "step", message: `writing ${BOX_GATEWAY_TARGETS_FILE}` };
      // A new boxed runtime cannot call a CUSTOM_JWT gateway that is in the project already.
      const runtime = newProjectSpec.runtimes.find(({ name }) => name === added);
      if (
        runtime &&
        runtimeRunsInBox(newProjectSpec, runtime) &&
        runtime.containment !== "PRIVATE_VPC"
      ) {
        for (const gateway of newProjectSpec.agentCoreGateways) {
          if (gateway.boundRuntime || gateway.authorizerType !== "CUSTOM_JWT") continue;
          yield { type: "warning", message: customJwtGatewayNotice(gateway.name) };
        }
      }
    }

    return {
      ...project,
      spec: newProjectSpec,
    };
  }

  /** Puts the record of build's targets back after a failed spec write; a failure is logged. */
  private restoreRecord(restore: RestoreRecord | undefined): void {
    try {
      restore?.();
    } catch (e) {
      const error = AgentCoreCLIError.fromError(e);
      this.logger
        .child({ errorName: error.name, errorMessage: error.message })
        .warn(`failed to restore ${BOX_GATEWAY_TARGETS_FILE}`);
    }
  }

  /** Best-effort removal of paths an add created; failures are logged, not thrown. */
  private async discardStaged(paths: string[]): Promise<void> {
    // A path inside another one goes with it. Removing both at the same time races: the
    // recursive remove of the folder can stop on a child the other remove took first.
    const inside = (child: string, parent: string) => {
      const path = relative(parent, child);
      return path !== "" && !path.startsWith("..") && !isAbsolute(path);
    };
    const outermost = [...new Set(paths)].filter(
      (path) => !paths.some((other) => inside(path, other)),
    );
    await Promise.all(
      outermost.map((p) =>
        rm(p, { recursive: true, force: true }).catch((e) => {
          const error = AgentCoreCLIError.fromError(e);
          this.logger
            .child({ errorName: error.name, errorMessage: error.message })
            .warn(`failed to clean up ${p}`);
        }),
      ),
    );
  }

  private getProjectSpecPath(project: Project): string {
    return projectSpecPath(project.rootPath);
  }

  public async removeResource(
    project: Project,
    input: RemoveResourceInput,
  ): Promise<RemoveResourceResult> {
    assertV1Project(project, "remove");
    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const existingProjectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    // A gateway bound to a runtime (each Box gateway is) belongs to that runtime: `remove runtime`
    // removes it. Its targets go with `remove gateway-target`.
    const boundGateway = existingProjectSpec.agentCoreGateways.find(
      (gateway) => gateway.name === input.name && isBoundGateway(gateway),
    );
    if (input.resourceType === "gateway" && boundGateway) {
      throw new InputValidationError(
        `the gateway '${input.name}' is bound to runtime '${boundGateway.boundRuntime}' and cannot ` +
          `be removed with 'remove gateway'. 'remove runtime' removes it. To remove its targets, ` +
          `use 'remove gateway-target --gateway ${input.name}'.`,
      );
    }

    let removed = false;
    let newSpec: unknown;
    let removedResource = input;
    let removedGateways: RemovedGateway[] = [];
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
      // The Box gateway entry stays, even with no targets: the CLI keeps one entry for each
      // runtime so the gateway is not removed by accident.
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
      // Build writes a target on each Box gateway for each other gateway of the project. Such a
      // target goes with its gateway. A target of the user's that names it stays: the schema does
      // not check an egress- target on a Box gateway, so the next deploy stops at synth because
      // the project has no gateway of that name.
      // Build owns the targets that the record lists, or by the egress- rule with no record.
      if (input.resourceType === "gateway" && removed) {
        const record = readBoxGatewayTargets(project.rootPath);
        // The record, when it names the Box gateway, says which of its targets build owns.
        const owns = (gateway: AgentCoreGateway, target: AgentCoreGatewayTarget) =>
          isBuildOwnedTarget(existingProjectSpec, gateway, target) &&
          (record && Object.hasOwn(record, gateway.name)
            ? record[gateway.name]!.includes(target.name)
            : true);
        newSpec = {
          ...(newSpec as object),
          agentCoreGateways: existingProjectSpec.agentCoreGateways
            .filter((gateway) => gateway.name !== input.name)
            .map((gateway) => ({
              ...gateway,
              targets: gateway.targets.filter(
                (target) => !(owns(gateway, target) && target.passthrough?.gateway === input.name),
              ),
            })),
        };
      }
      // A gateway bound to the runtime (each Box gateway is) goes with the runtime, and its
      // targets go too. A gateway bound to a runtime that does not exist fails validation.
      if (input.resourceType === "runtime" && removed) {
        const gateways = existingProjectSpec.agentCoreGateways;
        const bound = gateways.filter((gateway) => gateway.boundRuntime === input.name);
        removedGateways = bound.map(({ name, targets }) => ({ name, targetCount: targets.length }));
        if (bound.length > 0) {
          newSpec = {
            ...(newSpec as object),
            agentCoreGateways: gateways.filter((gateway) => gateway.boundRuntime !== input.name),
          };
        }
      }
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

    // A Box gateway that goes takes its entry in the record of build's targets with it.
    const newProjectSpec = await this.commitSpec(agentCoreSpecPath, newSpec, envFile, () =>
      removeBoxGatewaysFromRecord(
        project.rootPath,
        removedGateways.map(({ name }) => name),
        this.recordFiles,
      ),
    );
    // Build and deploy generate the runtime's .box/<name>/aws/ folder, so it goes with the runtime.
    // Its .box/<name>/local/ profile is the user's, as its code folder is, so it stays.
    if (input.resourceType === "runtime") {
      await rm(join(project.rootPath, ...boxAwsDir(input.name).split("/")), {
        recursive: true,
        force: true,
      });
    }

    return {
      project: { ...project, spec: newProjectSpec },
      removedEnvKeys,
      removedResource,
      removedGateways,
    };
  }

  public async removeAllResources(project: Project): Promise<RemoveResourcesResult> {
    assertV1Project(project, "remove all");
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
    // `projectType` stays: a Box project with no runtimes has no Box gateways, so the next deploy
    // still reaches the teardown confirmation. A runtime added later gets its Box gateway back
    // under the same name, so a deploy updates that gateway in place and does not delete it.
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

    const newProjectSpec = await this.commitSpec(agentCoreSpecPath, newSpec, envFile, () =>
      removeBoxGatewaysFromRecord(
        project.rootPath,
        existingProjectSpec.agentCoreGateways.map(({ name }) => name),
        this.recordFiles,
      ),
    );

    return {
      project: { ...project, spec: newProjectSpec },
      removedEnvKeys,
    };
  }

  /**
   * Writes `newSpec` to agentcore.json. `changeRecord` changes the record of build's targets just
   * before the write. When either fails, the record and `envFile` go back to what they were.
   */
  private async commitSpec(
    agentCoreSpecPath: string,
    newSpec: unknown,
    envFile: EnvLocalFile | undefined,
    changeRecord?: () => RestoreRecord | undefined,
  ): Promise<z.infer<typeof ProjectSpecSchema>> {
    let restoreRecord: RestoreRecord | undefined;
    try {
      const newSpecParseResult = ProjectSpecSchema.safeParse(newSpec);
      if (!newSpecParseResult.success)
        throw new InputValidationError(z.prettifyError(newSpecParseResult.error), {
          cause: newSpecParseResult.error,
        });
      restoreRecord = changeRecord?.();
      return await this.json.write(agentCoreSpecPath, newSpecParseResult.data);
    } catch (err) {
      this.restoreRecord(restoreRecord);
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
    project: Project | undefined,
    input: ExportHarnessInput,
  ): AsyncGenerator<ProjectEvent, ExportHarnessResult> {
    if (project) assertV1Project(project, "export harness");
    // Export adds a runtime, which a Box project cannot take.
    if (project) assertNotBoxProject(project.spec, "the exported harness as a runtime");
    if (!project) {
      if (!input.prefetched) {
        throw new ProjectStateError(
          "--name requires an AgentCore project. Use --arn to export a deployed harness into a new project.",
        );
      }
      const projectName = input.projectName ?? defaultExportProjectName(input.prefetched.spec.name);
      const destination = join(process.cwd(), projectName);
      const source = input.prefetched.sourceArn ? parseArn(input.prefetched.sourceArn) : undefined;
      const sourceTargets = source
        ? AwsDeploymentTargetsSchema.parse([
            {
              name: DEFAULT_TARGET_NAME,
              account: source.account,
              region: source.region,
            },
          ])
        : undefined;
      if (existsSync(destination)) {
        throw new InputValidationError(
          `the export project directory '${destination}' already exists; ` +
            "run export inside an existing AgentCore project or choose a different working directory",
        );
      }
      project = yield* this.create({ name: projectName });
      if (sourceTargets) {
        await this.json.write(
          join(project.rootPath, "agentcore", "aws-targets.json"),
          sourceTargets,
        );
      }
    }

    const agentCoreSpecPath = this.getProjectSpecPath(project);
    const { targetAgentName } = input;

    yield { type: "step", message: `reading project spec file at '${agentCoreSpecPath}'` };
    const projectSpec = await this.json.read(agentCoreSpecPath, ProjectSpecSchema);

    // Resolve the harness spec + system prompt: from the prefetched service
    // payload (--arn) or from the in-project harness files (--name).
    let harnessName: string;
    let spec: z.output<typeof HarnessSpecSchema>;
    // Undefined when the harness sets no prompt, so the export keeps the harness contract prompt.
    let systemPrompt: string | undefined;
    let harnessDir: string | undefined;
    if (input.prefetched) {
      spec = input.prefetched.spec;
      harnessName = spec.name;
      const prompt = input.prefetched.systemPrompt?.trim();
      systemPrompt = prompt && prompt.length > 0 ? prompt : spec.systemPrompt;
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
        message: `reading harness configuration from '${join(entry.path, "harness.yaml")}'`,
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
      systemPrompt = spec.systemPrompt;
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
        if (systemPrompt !== undefined && !systemPrompt.trim()) {
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
      message: `mapping harness '${harnessName}' to the Strands runtime template`,
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

    yield { type: "step", message: `rendering agent code at 'app/${targetAgentName}'` };
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

      yield { type: "step", message: `writing ${EXPORT_NOTES_FILENAME}` };
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
        yield { type: "step", message: `updating secrets file at '${envFile.path}'` };
        const { skipped } = await envFile.insertIfNew(plan.envEntries);
        for (const key of skipped) {
          yield {
            type: "step",
            message: `'${key}' already exists in ${ENV_LOCAL_RELATIVE_PATH}; left unchanged`,
          };
        }
      }

      yield { type: "step", message: `updating project spec file at '${agentCoreSpecPath}'` };
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

  private async scaffoldRuntimeResources(
    outputPath: string,
    input: RuntimeResourceConfig,
    written: string[] = [],
  ) {
    const resolver = getRuntimeTemplateResolver(
      { assetSource: this.assetSource, templateRenderer: this.templateRenderer },
      input,
    );
    if (!resolver)
      throw new InputValidationError(`unable to find template that matches given parameters`);

    const result = await resolver.resolve(input);
    await result.tree.write(dirname(outputPath), { written });
    return { spec: result.spec, envEntries: result.envEntries ?? [] };
  }

  public async *build(
    project: Project,
    input: BuildProjectInput & { region?: string } = {},
  ): AsyncGenerator<ProjectEvent, void> {
    assertV1Project(project, "build");
    // Half-written project files from an interrupted `agentcore migrate` must not
    // be synced or synthesized; build has no target, so only that state stops it.
    await assertNoPendingMigration(project.rootPath);
    const synced = await this.syncRuntimeBuilds(project, { purpose: "deploy" });
    for (const message of synced.messages) yield { type: "step", message };
    // Every runtime of a Box project runs in a box, so stop before anything is written.
    validateBoxRuntimes(synced.project.spec);
    // The region build writes the Box gateway's `bedrock` and `agentcore` targets and the
    // AgentCore Runtime profiles for: --region, else AWS_REGION, AWS_DEFAULT_REGION, the AWS config
    // file, then DEFAULT_REGION. Deploy uses its target's region instead.
    const boxed = await this.applyBoxNetwork(
      synced.project,
      "build",
      await resolveRegion(input.region, this.processEnv),
    );
    yield* boxed.events;
    yield* this.backendFor(project).build(boxed.project, {
      disableDependencyManagement: input.disableDependencyManagement,
      boxNetworks: boxed.networks,
    });
  }

  /**
   * Builds the Box network model of each box runtime from the box profile as Box resolves it
   * (`box profile show --format json --full`) for `region`, then writes what the Box network
   * writers derive from it, before synth reads agentcore.json and staging writes the Runtime
   * profile that each model derives (`BoxNetwork.runtimeProfile`): agentcore.json once, patched in
   * the raw file so unknown fields and key order survive and checked against the schema first,
   * then the files, then `.env.local`. A failure of any model stops `command` before anything is
   * written.
   */
  private async applyBoxNetwork(
    project: Project,
    command: "build" | "deploy",
    region: string,
  ): Promise<{ project: Project; networks: BoxNetwork[]; events: ProjectEvent[] }> {
    // Only a gateway that a boxed runtime calls through its Box gateway needs the check of the CDK
    // app: none for a CUSTOM_JWT gateway or a PRIVATE_VPC runtime.
    const boxRuntimes = project.spec.runtimes.filter((runtime) =>
      runtimeRunsInBox(project.spec, runtime),
    );
    const reached = reachedGatewayNames(project.spec, boxRuntimes);
    const projectGatewayCheck =
      reached.length > 0
        ? await this.cdkAcceptsPassthroughGateway(join(project.rootPath, "agentcore", "cdk"))
        : undefined;
    // Only a library that refuses passthrough.gateway is an answer; build then removes the
    // gateway targets. For each other reason, the command stops before it writes, so a transient
    // failure keeps the targets that a deploy needs.
    if (
      projectGatewayCheck &&
      !projectGatewayCheck.accepts &&
      projectGatewayCheck.reason !== "refuses"
    ) {
      throw new ProjectStateError(
        `${command === "build" ? "Build" : "Deploy"} stopped, and wrote nothing: build cannot ` +
          `tell if it can route the gateways ${gatewayList(reached)} of this project for a boxed ` +
          `agent, because ${uncheckedBecause(projectGatewayCheck)}`,
      );
    }
    const networks = await readBoxNetworks(
      project.spec,
      project.rootPath,
      this.boxProfileResolver,
      region,
      projectGatewayCheck,
    );
    if (networks.some(({ failures }) => failures.length > 0)) {
      throw new InputValidationError(boxNetworkFailureMessage(networks, command));
    }
    const envLocal = new EnvLocalFile(project.rootPath);
    const context = {
      spec: project.spec,
      projectRoot: project.rootPath,
      env: this.processEnv,
      envLocal: await envLocal.read(boxKeyReads(networks, project.spec, this.processEnv)),
    };
    const edits = boxNetworkEdits(BOX_NETWORK_WRITERS, networks, context);
    const messages = [...edits.messages];
    for (const file of edits.files) {
      const exists = existsSync(join(project.rootPath, ...file.path.split("/")));
      if ("remove" in file) {
        if (exists) messages.push(`removing ${file.path}`);
      } else if (!exists) {
        messages.push(`writing ${file.path}`);
      }
    }
    // agentcore.json is read and patched first, so a read or a schema failure writes nothing.
    // Only the fields a writer changed are set, so every other field keeps its value and place.
    // In the gateways, credentials, and runtimes, only the entries a writer changed, and only
    // their changed fields, so schema defaults are not written into the user's other entries.
    const specPath = this.getProjectSpecPath(project);
    let patched:
      { updated: Record<string, unknown>; spec: z.infer<typeof ProjectSpecSchema> } | undefined;
    if (edits.specChanged) {
      const raw = await this.json.read(specPath, z.record(z.string(), z.unknown()));
      const changes = edits.changedFields.map((field) => [
        field,
        field === "agentCoreGateways" || field === "credentials" || field === "runtimes"
          ? patchNamedEntries<{ name: string }>(raw[field], project.spec[field], edits.spec[field])
          : edits.spec[field],
      ]);
      const updated = { ...raw, ...Object.fromEntries(changes) };
      const parsed = ProjectSpecSchema.safeParse(updated);
      if (!parsed.success) {
        throw new ProjectStateError(z.prettifyError(parsed.error), { cause: parsed.error });
      }
      patched = { updated, spec: parsed.data };
    }
    // The record of the targets build owns changes with the gateway targets: it is written just
    // before agentcore.json, and goes back when agentcore.json cannot take the targets.
    const record = edits.files.find(
      (file): file is Extract<BoxNetworkFile, { text: string }> =>
        file.path === BOX_GATEWAY_TARGETS_FILE && "text" in file,
    );
    const files = edits.files.filter((file) => file !== record);
    const restoreRecord = record && replaceRecord(project.rootPath, record.text, this.recordFiles);
    let result = project;
    if (patched) {
      try {
        await this.json.write(specPath, patched.updated);
      } catch (err) {
        this.restoreRecord(restoreRecord);
        throw err;
      }
      result = { ...project, spec: patched.spec };
    }
    writeBoxNetworkFiles(project.rootPath, files);
    if (edits.envLocal.length > 0) {
      // Box credential keys follow their route's variable, so a rotated key replaces the stored one.
      const { written } = await envLocal.upsert([...edits.envLocal]);
      for (const key of written) messages.push(`writing ${key} to ${ENV_LOCAL_RELATIVE_PATH}`);
    }
    // Each box runtime gives the same warning for the CDK app, so it appears once.
    const warnings = [
      ...new Set([
        ...edits.warnings,
        ...networks.flatMap((network) => [
          ...network.warnings,
          ...boxGatewayIamWarnings(edits.spec, network),
        ]),
      ]),
    ];
    const events: ProjectEvent[] = [
      ...messages.map((message) => ({ type: "step" as const, message })),
      ...warnings.map((message) => ({ type: "warning" as const, message })),
    ];
    return { project: result, networks, events };
  }

  public async syncRuntimeBuilds(
    project: Project,
    input: SyncRuntimeBuildsInput,
  ): Promise<SyncRuntimeBuildsResult> {
    // A v0 project's agentcore.json has the v0 shape and is never rewritten here.
    if (project.legacy) return { project, messages: [], written: false };
    const runtimes = input.runtimeNames
      ? project.spec.runtimes.filter((runtime) => input.runtimeNames!.includes(runtime.name))
      : project.spec.runtimes;
    const prepared = prepareRuntimes(project.rootPath, runtimes, input.purpose, {
      boxProject: isBoxProject(project.spec),
    });
    if (prepared.changed.length === 0) {
      return { project, messages: prepared.messages, written: false };
    }

    // Patch the raw file rather than re-serializing the parsed spec, so fields
    // the schema does not know about, and the order of every key, survive.
    const specPath = this.getProjectSpecPath(project);
    const raw = await this.json.read(specPath, z.record(z.string(), z.unknown()));
    const rawRuntimes = Array.isArray(raw.runtimes) ? [...(raw.runtimes as unknown[])] : [];
    for (const { runtime, changes } of prepared.changed) {
      const index = rawRuntimes.findIndex(
        (entry) => (entry as { name?: unknown } | null)?.name === runtime.name,
      );
      if (index < 0) continue;
      const entry: Record<string, unknown> = { ...(rawRuntimes[index] as object) };
      for (const { field, to } of changes) {
        if (to === undefined) delete entry[field];
        else entry[field] = to;
      }
      rawRuntimes[index] = entry;
    }
    const updated = { ...raw, runtimes: rawRuntimes };
    const parsed = ProjectSpecSchema.safeParse(updated);
    if (!parsed.success) {
      throw new ProjectStateError(z.prettifyError(parsed.error), { cause: parsed.error });
    }
    await this.json.write(specPath, updated);
    return {
      project: { ...project, spec: parsed.data },
      messages: prepared.messages,
      written: true,
    };
  }

  // Resolves the named target from aws-targets.json before handing off, so the
  // backend receives a fully resolved account and region and never has to know
  // how targets are stored. The backend owns everything after that point.
  public async *deploy(
    project: Project,
    input: DeployProjectInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    assertV1Project(project, "deploy");
    // A target `agentcore migrate` hasn't finished with still has its v0 logical
    // IDs; every deploy path (CLI, TUI, harness dev) comes through here.
    await assertNoPendingMigration(project.rootPath, input.target);
    const targetsPath = join(project.rootPath, "agentcore", "aws-targets.json");
    const fileExists = existsSync(targetsPath);
    const targets = await this.listTargets(project);

    let target = targets.find((candidate) => candidate.name === input.target);

    // A freshly created project defines no targets, so the default one is
    // synthesized from the environment rather than demanded up front. Only
    // `default` gets this treatment: inventing a *named* target would turn a
    // typo'd --target into a deployment somewhere unintended.
    if (!target && input.target === DEFAULT_TARGET_NAME) {
      // Box runs only on AgentCore Runtime V2, so stop before STS or aws-targets.json.
      assertRuntimeV2RegionSupported(
        project.spec,
        { name: DEFAULT_TARGET_NAME, region: input.region },
        { provisioning: true, otherTargets: targets.length > 0 },
      );
      target = await this.provisionDefaultTarget(project, targetsPath, input.region);
      yield {
        type: "step",
        message:
          `created default deployment target: account ${target.account}, ` +
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

    // Box runs only on AgentCore Runtime V2, so stop before the sync rewrites agentcore.json.
    assertRuntimeV2RegionSupported(project.spec, target);

    // Synth reads agentcore.json, so it is brought up to date with the code
    // first; only once the target is known, so a bad --target rewrites nothing.
    const synced = await this.syncRuntimeBuilds(project, { purpose: "deploy" });
    for (const message of synced.messages) yield { type: "step", message };
    // Every runtime of a Box project runs in a box, so stop before anything is written.
    validateBoxRuntimes(synced.project.spec);
    const boxed = await this.applyBoxNetwork(synced.project, "deploy", target.region);
    yield* boxed.events;
    project = boxed.project;
    // Resolved once, after auto-detection, so the caller (telemetry) and the
    // backend see the build modes this deploy actually uses.
    const { builds: workloadBuilds, local: localWorkloads } = resolveWorkloads(project);
    input.onWorkloadBuilds?.(workloadBuilds);

    // China (aws-cn) targets cannot run runtimes whose scaffolded code is
    // wired to Bedrock/Anthropic/OpenAI/Gemini (unreachable there), nor
    // harnesses (not part of the China launch). Runtimes without a persisted
    // modelProvider (BYO, provider-free, hand-edited, or scaffolded by an
    // older CLI) cannot be classified and only get an informational note.
    if (isChinaRegion(target.region)) {
      const bmaRuntimes = project.spec.runtimes.filter(
        (runtime) => runtime.bedrockManagedAgents === true,
      );
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
      // The collection check lets Gateways through as a whole; connector-backed
      // Targets inside them (hand-edited, or added before the China target) are
      // refused here with the same message the add gate gives.
      for (const gateway of project.spec.agentCoreGateways) {
        const connector = gateway.targets.find((candidate) => candidate.targetType === "connector");
        if (connector !== undefined) {
          throw new RegionUnsupportedFeatureError(
            `Cannot deploy to China region ${target.region}: gateway '${gateway.name}' target ` +
              `'${connector.name}' is a connector. ${cnConnectorTargetMessage(connector.connectorId)}`,
          );
        }
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
      skipBootstrap: input.skipBootstrap,
      boxNetworks: boxed.networks,
      workloadBuilds,
      localWorkloads,
      disableDependencyManagement: input.disableDependencyManagement,
    });
  }

  // A read-only lookup, so callers (e.g. the deploy handler's up-front teardown
  // confirmation) can name the target's account and region without triggering
  // the default-target provisioning deploy performs.
  public async listTargets(project: Project): Promise<AwsDeploymentTarget[]> {
    const targetsPath = join(project.rootPath, "agentcore", "aws-targets.json");
    if (!existsSync(targetsPath)) return [];
    return this.json.read(
      targetsPath,
      project.legacy ? V0AwsDeploymentTargetsSchema : AwsDeploymentTargetsSchema,
    );
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
      ? await this.json.read(
          targetsPath,
          project.legacy ? V0AwsDeploymentTargetsSchema : AwsDeploymentTargetsSchema,
        )
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
    let account: string;
    try {
      account = await this.resolveAccount(region);
    } catch (error) {
      const cause = AgentCoreCLIError.fromError(error);
      throw new InvalidEnvironmentError(
        `Cannot create the default deployment target for project '${project.name}' because ` +
          `the AWS account could not be resolved in region '${region}': ${cause.message}\n` +
          // With no region allowlist, a mistyped or not-enabled region surfaces here as an STS
          // failure, so the hint names the region before suggesting credentials.
          `Check that '${region}' is a region enabled for your account (--region or AWS_REGION), ` +
          `and sign in with 'aws login' (or set AWS_PROFILE or credential environment variables), ` +
          `then re-run 'agentcore deploy'.`,
        { cause: error },
      );
    }

    const entry = AwsDeploymentTargetSchema.safeParse({
      name: DEFAULT_TARGET_NAME,
      account,
      region,
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
      // `agentcore dev` runs a CodeZip box agent with the box on PATH; a container's image has its own.
      if (input.scaffoldRuntimeInput && startsInBoxOnCodeZip(input.scaffoldRuntimeInput)) {
        await this.checkTool("box", BOX_INSTALL_HINT);
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
   * Gives the runtime `boxInput` names, just added to the Box project `projectSpec`, what create
   * gives a CodeZip box runtime: `box.version`, start.py as its entry point, its own Box gateway,
   * and its own box profile in `.box/<name>/local/`. Each path it creates goes into
   * `scaffoldedPaths`, so a failed add removes it; a file or folder the user already had stays.
   */
  private async *addBoxRuntime(
    projectRoot: string,
    projectSpec: z.infer<typeof ProjectSpecSchema>,
    boxInput: ScaffoldRuntimeInput,
    scaffoldedPaths: string[],
    region: string,
  ): AsyncGenerator<ProjectEvent, void> {
    const name = boxInput.runtimeName;
    const runtime = projectSpec.runtimes.find((candidate) => candidate.name === name)!;
    // The box release build and deploy ship, as create pins it.
    runtime.box = { version: BOX_RELEASE.version };
    // Box runs only on AgentCore Runtime V2, as create pins it.
    runtime.platformVersion = BOX_PLATFORM_VERSION;
    // start.py starts `box run` on AgentCore Runtime, and the profile runs the agent.
    runtime.entrypoint = BOX_CODEZIP_ENTRYPOINT;
    // The fallback template tag, strands-box, which resolveRuntimeTemplateProfile gives a box
    // runtime no template made. boxRuntimeInput refused the key in --tags. Its Box gateway takes
    // the same value.
    runtime.tags = { ...runtime.tags, ...resolveRuntimeTemplateProfile(boxInput)?.runtime?.tags };
    projectSpec.agentCoreGateways.push(
      AgentCoreGatewaySchema.parse(boxGatewaySpec(name, runtime.tags[TEMPLATE_TAG_KEY]!)),
    );

    // start.py and an empty .venv, as create writes them. A file or folder the user has stays.
    const appDir = join(projectRoot, ...runtime.codeLocation.split("/"));
    const venv = join(appDir, ".venv");
    if (!existsSync(venv)) scaffoldedPaths.push(venv);
    await FsTreeNode.createDirectory(basename(appDir), boxCodeZipFiles(this.assetSource)).write(
      dirname(appDir),
      { skipExisting: true, written: scaffoldedPaths },
    );
    const boxFolder = join(projectRoot, ...boxAgentDir(name).split("/"));
    if (!existsSync(boxFolder)) scaffoldedPaths.push(boxFolder);
    yield* this.writeBoxProfile(projectRoot, projectSpec.name, boxInput, region);
  }

  /**
   * Throws when `appDir` already holds a start.py that is not the one that starts box. A box
   * runtime runs start.py as its entry point, so AgentCore Runtime would run the user's file with
   * no box, while build still writes the runtime's box profile and Box gateway.
   */
  private async assertNoOtherStartScript(appDir: string, runtimeName: string): Promise<void> {
    const startScript = join(appDir, BOX_CODEZIP_ENTRYPOINT);
    if (!existsSync(startScript)) return;
    const boxStart = await this.assetSource.read(`templates/box-codezip/${BOX_CODEZIP_ENTRYPOINT}`);
    if ((await readFile(startScript, "utf8")) === boxStart) return;
    const shown = `app/${runtimeName}/${BOX_CODEZIP_ENTRYPOINT}`;
    throw new InputValidationError(
      `cannot add runtime '${runtimeName}' to a Box project: ${shown} exists, and it is not the ` +
        `${BOX_CODEZIP_ENTRYPOINT} that starts box. A box runtime runs ${BOX_CODEZIP_ENTRYPOINT} as ` +
        `its entry point, so AgentCore Runtime would run your file with no box. Rename ${shown}, ` +
        "then retry.",
    );
  }

  /**
   * Writes the box profile that runs the scaffolded agent into the agent's
   * `.box/<runtime>/local/` folder, named after the project and the runtime,
   * calling Bedrock in `region`, and first, beside it, the policy file the
   * profile lists. An existing profile is the user's, so it is never
   * overwritten, and then neither file is written. The policy file is the CLI's,
   * so it replaces one already there.
   */
  private async *writeBoxProfile(
    projectRoot: string,
    projectName: string,
    runtime: ScaffoldRuntimeInput,
    region: string,
  ): AsyncGenerator<ProjectEvent, void> {
    const text = renderBoxProfile(projectName, runtime, region);
    if (text === undefined) return;
    const path = boxLocalProfilePath(projectRoot, runtime.runtimeName);
    if (existsSync(path)) {
      yield { type: "warning", message: `box profile ${path} already exists; left unchanged` };
      const kept = ingressPort(await readFile(path, "utf8"));
      const wanted = ingressPort(text);
      if (kept !== undefined && wanted !== undefined && kept !== wanted) {
        yield {
          type: "warning",
          message:
            `box profile ${path} is for another protocol: it listens on port ${kept}, and a ` +
            `${runtime.protocol ?? "HTTP"} runtime listens on port ${wanted}. Remove ` +
            `${dirname(path)}, then add the runtime again, or edit the profile.`,
        };
      }
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    // The profile lists this file under `policies`, and box refuses the profile without it, so it
    // is written first: a failed write then leaves no profile that names a missing file.
    const policy = boxLocalMetadataPolicyPath(projectRoot, runtime.runtimeName);
    yield { type: "step", message: `writing box policy file ${policy}` };
    await writeFile(policy, renderAwsMetadataPolicy());
    yield { type: "step", message: `writing box profile ${path}` };
    await writeFile(path, text, { flag: "wx" });
    for (const message of boxProfileWarnings(runtime)) yield { type: "warning", message };
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
      yield { type: "step", message: "syncing Python dependencies with uv" };
      // A boxed CodeZip agent's profile grants exec only on the uv-managed Pythons in uv's default
      // folder, so its venv must link to one there, not to a Homebrew or system Python, or to a
      // Python in the user's own UV_PYTHON_INSTALL_DIR. A container image builds its own venv.
      const env =
        input && input.build === "CodeZip" && hasBoxProfile(input)
          ? { ...process.env, ...boxUvSyncEnv(homedir()) }
          : undefined;
      yield* this.run(["uv", "sync"], appDir, undefined, env);
    } else if (existsSync(join(appDir, "package.json"))) {
      await this.checkTool("npm", NODE_INSTALL_HINT);
      yield { type: "step", message: "installing Node dependencies with npm" };
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
      yield { type: "step", message: `generating ${lockfile} for container build` };
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
    env?: NodeJS.ProcessEnv,
  ): AsyncGenerator<ProjectEvent, void, unknown> {
    yield* withOutputEvents((emit) => {
      const lines = createLineSplitter((line) => {
        const formatted = formatLine(line);
        if (formatted !== undefined) emit(formatted);
      });
      return this.runner(command, {
        cwd,
        ...(env && { env }),
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

/**
 * The resource whose files live in `folder` (a runtime's codeLocation, a
 * harness's path, or a managed code-based evaluator's codeLocation), if any.
 */
function appFolderOwner(
  spec: z.infer<typeof ProjectSpecSchema>,
  rootPath: string,
  folder: string,
): string | undefined {
  const owners: [string, string | undefined][] = [
    ...spec.runtimes.map((runtime): [string, string] => [
      `runtime '${runtime.name}'`,
      runtime.codeLocation,
    ]),
    ...spec.harnesses.map((harness): [string, string] => [
      `harness '${harness.name}'`,
      harness.path,
    ]),
    ...spec.evaluators.map((evaluator): [string, string | undefined] => [
      `evaluator '${evaluator.name}'`,
      evaluator.config.codeBased?.managed?.codeLocation,
    ]),
  ];
  // The same folder, one inside the other, or one containing the other (a
  // codeLocation of `app`) all mean the two resources would share files.
  const overlaps = (location: string) => {
    const owned = resolve(rootPath, location);
    const target = resolve(folder);
    return owned === target || isInside(owned, target) || isInside(target, owned);
  };
  return owners.find(([, location]) => location !== undefined && overlaps(location))?.[0];
}

/** Whether `path` is strictly inside `dir`. */
function isInside(path: string, dir: string): boolean {
  const relativePath = relative(dir, path);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/** What the CLI tells the user about the `APPLICATION_LOGS` of a Box gateway that it writes. */
export function boxGatewayLogsNotice(gatewayName: string): string {
  return (
    `the Box gateway '${gatewayName}' sends its APPLICATION_LOGS to CloudWatch Logs, which keeps ` +
    "them for 90 days. They can hold the request and response bodies of its calls, prompts and " +
    `completions included. To stop them, set "enableApplicationLogs": false on that gateway in ` +
    "agentcore/agentcore.json"
  );
}

/**
 * A warning for each gateway of `gateways` that is a Box gateway and sends its `APPLICATION_LOGS`.
 * Each command that writes a new Box gateway gives these warnings: `create` and `add runtime`.
 */
function boxGatewayLogsWarnings(
  gateways: readonly { name: string; boundRuntime?: string; enableApplicationLogs?: boolean }[],
): ProjectEvent[] {
  return gateways
    .filter((gateway) => isBoundGateway(gateway) && gateway.enableApplicationLogs)
    .map((gateway) => ({ type: "warning", message: boxGatewayLogsNotice(gateway.name) }));
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

/** The port of the first `[[agent.ingress]] listen` in the box profile `text`, if it names one. */
function ingressPort(text: string): string | undefined {
  return /^\s*listen\s*=\s*"[^"]*:(\d+)"/m.exec(text)?.[1];
}

/**
 * The notice of the default log target (defaultLogTargetNotice) for each runtime of `runtimes` that
 * runs in a box in `spec`, and that does not turn observability off.
 */
function defaultLogTargetNotices(
  spec: z.infer<typeof ProjectSpecSchema>,
  runtimes: readonly z.infer<typeof ProjectSpecSchema>["runtimes"][number][],
): ProjectEvent[] {
  return runtimes
    .filter((runtime) => runsInBox(isBoxProject(spec), runtime) && !observabilityOff(runtime))
    .map((runtime) => ({
      type: "warning",
      message: defaultLogTargetNotice(runtime.name, boxLocalProfileFile(runtime.name)),
    }));
}

/**
 * Refuses to export a harness as a runtime into a Box project. Every runtime of a Box project runs
 * in a box, and the exported harness runs its agent the usual way.
 */
function assertNotBoxProject(spec: z.infer<typeof ProjectSpecSchema>, what: string): void {
  if (!isBoxProject(spec)) return;
  throw new ProjectStateError(
    `cannot add ${what}: every runtime of a Box project runs in a box, and the exported ` +
      "harness does not. Export it into a project that is not a Box project.",
  );
}

/**
 * The input that the box profile of `config`, a docs-only runtime added to the Box project `spec`,
 * renders from: a Python CodeZip agent with the framework `none` and Bedrock, as
 * agent-python-minimal-box has. Throws for a Bedrock Agent import, for a TypeScript runtime, for a
 * runtime whose Box gateway name is taken, for `--tags` that set `agentcore:template`, and for tags
 * that would pass the limit of 50 at deploy.
 */
function boxRuntimeInput(
  spec: z.infer<typeof ProjectSpecSchema>,
  config: RuntimeResourceConfig | RuntimeDocsConfig,
): ScaffoldRuntimeInput {
  // The imported agent can call Bedrock Agent and action group hosts that the box profile of a
  // new runtime does not allow, so a Box project does not take an import yet.
  if (!isRuntimeDocsConfig(config)) {
    throw new InputValidationError(
      `cannot add runtime '${config.name}' to a Box project from a Bedrock Agent import: every ` +
        "runtime of a Box project runs in a box, and the box profile of an added runtime does not " +
        "allow the hosts an imported agent calls. Import it into a project that is not a Box " +
        "project, or add a runtime with --language python.",
    );
  }
  if (config.language !== "Python") {
    throw new InputValidationError(
      `cannot add runtime '${config.name}' to a Box project: every runtime of a Box project ` +
        "runs in a box, and add runtime adds a box runtime only as a Python CodeZip agent. Add " +
        "it with --language python.",
    );
  }
  const gateway = boxGatewayName(config.name);
  if (spec.agentCoreGateways.some(({ name }) => name === gateway)) {
    throw new InputValidationError(
      `cannot add runtime '${config.name}': its Box gateway needs the name '${gateway}', and a ` +
        "gateway with that name already exists. Choose a different --name.",
    );
  }
  // The template tag key and the tag count are checked here, before add runtime writes anything.
  if (config.tags?.[TEMPLATE_TAG_KEY] !== undefined) {
    throw new InputValidationError(
      `cannot add runtime '${config.name}' to a Box project: the CLI sets the tag ` +
        `${TEMPLATE_TAG_KEY} on each runtime of a Box project. Remove it from --tags.`,
    );
  }
  // At deploy the CDK library gives the runtime the project's tags too, so count them with its own.
  // Its Box gateway gets only the project's tags and the template tag, never more, so this covers
  // it too.
  const tags = Object.keys({ ...spec.tags, ...config.tags, [TEMPLATE_TAG_KEY]: "" }).length;
  if (tags > MAX_TAGS) {
    throw new InputValidationError(
      `cannot add runtime '${config.name}' to a Box project: it would have ${tags} tags at ` +
        `deploy, over the limit of ${MAX_TAGS}: its --tags, the tags of the project, and the tag ` +
        `${TEMPLATE_TAG_KEY} that the CLI sets on each runtime of a Box project. Pass fewer ` +
        "--tags, or remove tags from the project.",
    );
  }
  return {
    runtimeName: config.name,
    build: "CodeZip",
    language: "Python",
    framework: "none",
    protocol: config.protocol ?? "HTTP",
    modelProvider: "Bedrock",
    runtimeVersion: LATEST_PYTHON,
    boxTemplate: true,
  };
}

/**
 * The raw agentcore.json array `raw` with the edits that turned the parsed entries `before` into
 * `after`, matched by name: an entry `after` changed gets only its changed fields, so its other
 * keys, their order, and fields the schema does not know about survive; a new entry is appended,
 * and one `after` dropped is removed. Every other entry stays as the user wrote it.
 */
function patchNamedEntries<T extends { name: string }>(
  raw: unknown,
  before: readonly T[],
  after: readonly T[],
): unknown[] {
  const entries = Array.isArray(raw) ? [...(raw as unknown[])] : [];
  const nameOf = (entry: unknown) => (entry as { name?: unknown } | null)?.name;
  const kept = new Set(after.map(({ name }) => name));
  const patched = entries.filter((entry) => {
    const name = nameOf(entry);
    return typeof name !== "string" || kept.has(name) || !before.some((b) => b.name === name);
  });
  for (const entry of after) {
    const old = before.find(({ name }) => name === entry.name);
    if (old && isDeepStrictEqual(old, entry)) continue;
    const index = patched.findIndex((candidate) => nameOf(candidate) === entry.name);
    if (!old || index < 0) {
      patched.push(entry);
      continue;
    }
    const next: Record<string, unknown> = { ...(patched[index] as object) };
    const oldFields = old as Record<string, unknown>;
    const newFields = entry as Record<string, unknown>;
    for (const key of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
      if (isDeepStrictEqual(oldFields[key], newFields[key])) continue;
      if (newFields[key] === undefined) delete next[key];
      else next[key] = newFields[key];
    }
    patched[index] = next;
  }
  return patched;
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
