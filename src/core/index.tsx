import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { IAMClient } from "@aws-sdk/client-iam";
import { HarnessClient } from "./harness";
import { RuntimeClient } from "./runtime";
import type {
  AwsClients,
  ClientConfig,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
} from "./types";

export type {
  AwsClients,
  ClientConfig,
  CreateControlClient,
  CreateDataClient,
  CreateIamClient,
} from "./types";

// CoreClient is the single entry point to the Bedrock AgentCore APIs. It owns the
// underlying SDK clients (one per config, created on demand from the injected
// factories) and exposes feature-scoped sub-clients such as `harness`, keeping the
// surface modular as more features are added.
export class CoreClient implements AwsClients {
  private controlClients = new Map<string, BedrockAgentCoreControlClient>();
  private dataClients = new Map<string, BedrockAgentCoreClient>();
  private iamClients = new Map<string, IAMClient>();

  // Feature-scoped sub-clients. Access as e.g. `coreClient.harness.getHarness(...)`.
  readonly harness: HarnessClient = new HarnessClient(this);
  readonly runtime: RuntimeClient = new RuntimeClient(this);

  constructor(
    private readonly createControlClient: CreateControlClient,
    private readonly createDataClient: CreateDataClient,
    private readonly createIamClient: CreateIamClient,
  ) {}

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
  // use (used to provision default harness execution roles).
  iam(config: ClientConfig): IAMClient {
    const key = cacheKey(config);
    let client = this.iamClients.get(key);
    if (!client) {
      client = this.createIamClient(config);
      this.iamClients.set(key, client);
    }
    return client;
  }
}

// cacheKey derives a stable cache key from a ClientConfig so that distinct
// configurations (region, endpoint, ...) map to distinct cached clients.
function cacheKey(config: ClientConfig): string {
  return JSON.stringify(config);
}
