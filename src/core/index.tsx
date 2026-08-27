import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EvalClient } from "./eval";
import { GatewayClient } from "./gateway";
import { HarnessClient } from "./harness";
import { IdentityClient } from "./identity";
import { MemoryClient } from "./memory";
import { RuntimeClient } from "./runtime";
import type {
  AwsClients,
  ClientConfig,
  CoreFetch,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
} from "./types";
import type { Logger } from "../logging";
import type { ProjectManager } from "../handlers/project/types";
import { FsProjectManager } from "./project";

export type {
  AwsClients,
  ClientConfig,
  CoreFetch,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
  CreateLogsClient,
} from "./types";

type CoreClientConfig = {
  createControlClient: CreateControlClient;
  createDataClient: CreateDataClient;
  createIamClient: CreateIamClient;
  createLogsClient: CreateLogsClient;
  logger: Logger;
  fetch?: CoreFetch;
  newSessionId?: () => string;
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

  readonly projectManager: ProjectManager;

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
    );

    this.projectManager = new FsProjectManager({
      logger: this.logger.child({ module: "projectManager" }),
    });
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
function cacheKey(config: ClientConfig): string {
  return JSON.stringify(config);
}
