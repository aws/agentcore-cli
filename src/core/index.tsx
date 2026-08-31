import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EvalClient } from "./eval";
import { GatewayClient } from "./gateway";
import { HarnessClient } from "./harness";
import { IdentityClient } from "./identity";
import { MemoryClient } from "./memory";
import { ObservabilityClient } from "./observability";
import { RuntimeClient } from "./runtime";
import { FsReadWriteJson } from "../io";
import type {
  AwsClients,
  ClientConfig,
  CoreFetch,
  CreateCloudFormationClient,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
} from "./types";
import type { Logger } from "../logging";
import type { ProjectManager } from "../handlers/project/types";
import { FsProjectManager } from "./project";
import { describeBedrockAgent, type DescribeBedrockAgent } from "./project/bedrockAgent";

export type {
  AwsClients,
  ClientConfig,
  CoreFetch,
  CreateControlClient,
  CreateCloudFormationClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
} from "./types";

type CoreClientConfig = {
  createCloudFormationClient?: CreateCloudFormationClient;
  createControlClient: CreateControlClient;
  createDataClient: CreateDataClient;
  createIamClient: CreateIamClient;
  createLogsClient: CreateLogsClient;
  logger: Logger;
  fetch?: CoreFetch;
  newSessionId?: () => string;
  now?: () => number;
  describeBedrockAgent?: DescribeBedrockAgent;
};

// CoreClient is the single entry point to the Bedrock AgentCore APIs. It owns the
// underlying SDK clients (one per config, created on demand from the injected
// factories) and exposes feature-scoped sub-clients such as `harness`, keeping the
// surface modular as more features are added.
export class CoreClient implements AwsClients {
  private controlClients = new Map<string, BedrockAgentCoreControlClient>();
  private dataClients = new Map<string, BedrockAgentCoreClient>();
  private iamClients = new Map<string, IAMClient>();
  private logsClients = new Map<string, CloudWatchLogsClient>();

  private readonly createControlClient: CreateControlClient;
  private readonly createDataClient: CreateDataClient;
  private readonly createIamClient: CreateIamClient;
  private readonly createLogsClient: CreateLogsClient;
  private logger: Logger;

  // Feature-scoped sub-clients. Access as e.g. `coreClient.harness.getHarness(...)`.
  readonly harness: HarnessClient = new HarnessClient(this);
  readonly identity: IdentityClient = new IdentityClient(this);
  readonly memory: MemoryClient = new MemoryClient(this);
  readonly runtime: RuntimeClient;
  readonly gateway: GatewayClient;
  readonly eval: EvalClient;
  readonly observability: ObservabilityClient;

  readonly projectManager: ProjectManager;
  readonly describeBedrockAgent: DescribeBedrockAgent;

  constructor(config: CoreClientConfig) {
    this.createControlClient = config.createControlClient;
    this.createDataClient = config.createDataClient;
    this.createIamClient = config.createIamClient;
    this.createLogsClient = config.createLogsClient;
    this.logger = config.logger;
    const fetch = config.fetch ?? globalThis.fetch;
    this.runtime = new RuntimeClient(this, fetch, this.logger.child({ module: "runtime" }));
    this.gateway = new GatewayClient(this, fetch, this.logger.child({ module: "gateway" }));
    // EvalClient shares the injected fetch: dataset content is served from a
    // presigned S3 URL, outside the SDK seam the other operations use. The logger
    // is used for batch-evaluation result-log diagnostics.
    this.eval = new EvalClient(
      this,
      fetch,
      this.logger.child({ module: "eval" }),
      config.newSessionId,
      config.now,
    );

    // Observability resolves a project's deployed runtime from its stack
    // outputs, so it reads aws-targets.json through the same JSON layer the
    // project manager uses.
    this.observability = new ObservabilityClient(this, {
      readJson: new FsReadWriteJson({
        logger: this.logger.child({ module: "observability" }),
      }),
    });

    this.projectManager = new FsProjectManager({
      logger: this.logger.child({ module: "projectManager" }),
      createCloudFormationClient: config.createCloudFormationClient,
      // A project deploy provisions credential providers through the same Identity
      // client the `agentcore identity` commands use, against its target's credentials.
      identity: this.identity,
    });
    this.describeBedrockAgent = config.describeBedrockAgent ?? describeBedrockAgent;
  }

  // control returns the control-plane client for `config`, creating and caching it
  // on first use.
  control(config: ClientConfig): BedrockAgentCoreControlClient {
    const key = cacheKey(config);
    let client = this.controlClients.get(key);
    if (!client) {
      client = this.createControlClient(config);
      this.controlClients.set(key, client);
    }
    return client;
  }

  // data returns the data-plane client for `config`, creating and caching it on
  // first use.
  data(config: ClientConfig): BedrockAgentCoreClient {
    const key = cacheKey(config);
    let client = this.dataClients.get(key);
    if (!client) {
      client = this.createDataClient(config);
      this.dataClients.set(key, client);
    }
    return client;
  }

  // iam returns the IAM client for `config`, creating and caching it on first
  // use (used to provision default execution roles).
  iam(config: ClientConfig): IAMClient {
    const key = cacheKey(config);
    let client = this.iamClients.get(key);
    if (!client) {
      client = this.createIamClient(config);
      this.iamClients.set(key, client);
    }
    return client;
  }

  // logs returns the CloudWatch Logs client for `config`, creating and caching it
  // on first use (used to read batch-evaluation result log streams).
  logs(config: ClientConfig): CloudWatchLogsClient {
    const key = cacheKey(config);
    let client = this.logsClients.get(key);
    if (!client) {
      client = this.createLogsClient(config);
      this.logsClients.set(key, client);
    }
    return client;
  }
}

// cacheKey derives a stable cache key from a ClientConfig so that distinct
// configurations (region, endpoint, ...) map to distinct cached clients.
//
// `credentials` is a provider function or an object of resolved credentials, so it
// cannot be serialized — JSON.stringify drops functions silently, which would map two
// callers with different credentials in the same region onto one cached client. It is
// keyed by identity instead.
function cacheKey(config: ClientConfig): string {
  const { credentials, ...serializable } = config;
  const suffix = credentials ? `|credentials:${credentialsId(credentials)}` : "";
  return JSON.stringify(serializable) + suffix;
}

const credentialsIds = new WeakMap<object, number>();
let nextCredentialsId = 0;

// credentialsId assigns each credential source a stable id for the lifetime of the
// object, so the same source reuses its client and a different one gets its own.
function credentialsId(credentials: NonNullable<ClientConfig["credentials"]>): number {
  let id = credentialsIds.get(credentials);
  if (id === undefined) {
    id = nextCredentialsId++;
    credentialsIds.set(credentials, id);
  }
  return id;
}
