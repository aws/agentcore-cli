import { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { IAMClient } from "@aws-sdk/client-iam";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EvalClient } from "./eval";
import { GatewayClient } from "./gateway";
import { HarnessClient } from "./harness";
import { IdentityClient } from "./identity";
import { MemoryClient } from "./memory";
import { PolicyClient } from "./policy";
import { ObservabilityClient } from "./observability";
import { RuntimeClient } from "./runtime";
import type { OpenRuntimeShell } from "./runtime";
import { FsReadWriteJson } from "../io";
import type {
  AwsClients,
  AwsCredentials,
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
import { BedrockAgentImporter, type CoreBedrockAgentImporter } from "./project/bedrockAgentImport";

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
  bedrockAgentImporter?: CoreBedrockAgentImporter;
  openRuntimeShell?: OpenRuntimeShell;
};

// CoreClient is the single entry point to the Bedrock AgentCore APIs. It owns the
// underlying SDK clients (one per config, created on demand from the injected
// factories) and exposes feature-scoped sub-clients such as `harness`, keeping the
// surface modular as more features are added.
export class CoreClient implements AwsClients {
  private controlClients = new ClientCache<BedrockAgentCoreControlClient>();
  private dataClients = new ClientCache<BedrockAgentCoreClient>();
  private iamClients = new ClientCache<IAMClient>();
  private logsClients = new ClientCache<CloudWatchLogsClient>();

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
  readonly policy: PolicyClient;

  readonly projectManager: ProjectManager;
  readonly bedrockAgentImporter: CoreBedrockAgentImporter;
  readonly fetch: CoreFetch;

  constructor(config: CoreClientConfig) {
    this.createControlClient = config.createControlClient;
    this.createDataClient = config.createDataClient;
    this.createIamClient = config.createIamClient;
    this.createLogsClient = config.createLogsClient;
    this.logger = config.logger;
    const fetch = config.fetch ?? globalThis.fetch;
    this.fetch = fetch;
    this.runtime = new RuntimeClient(
      this,
      fetch,
      this.logger.child({ module: "runtime" }),
      config.openRuntimeShell,
    );
    this.gateway = new GatewayClient(this, fetch, this.logger.child({ module: "gateway" }));
    this.policy = new PolicyClient(this, this.logger.child({ module: "policy" }));
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
      identity: this.identity,
    });
    this.bedrockAgentImporter = config.bedrockAgentImporter ?? new BedrockAgentImporter();
  }

  // control returns the control-plane client for `config`, creating and caching it
  // on first use.
  control(config: ClientConfig): BedrockAgentCoreControlClient {
    return this.controlClients.get(config, this.createControlClient);
  }

  // data returns the data-plane client for `config`, creating and caching it on
  // first use.
  data(config: ClientConfig): BedrockAgentCoreClient {
    return this.dataClients.get(config, this.createDataClient);
  }

  // iam returns the IAM client for `config`, creating and caching it on first
  // use (used to provision default execution roles).
  iam(config: ClientConfig): IAMClient {
    return this.iamClients.get(config, this.createIamClient);
  }

  // logs returns the CloudWatch Logs client for `config`, creating and caching it
  // on first use (used to read batch-evaluation result log streams).
  logs(config: ClientConfig): CloudWatchLogsClient {
    return this.logsClients.get(config, this.createLogsClient);
  }
}

// ClientCache holds one SDK client per distinct configuration, so callers asking for
// the same region (and endpoint, and credentials) share a connection.
//
// Credentials cannot be part of a serialized key: they are either a provider function
// or an object of resolved credentials, and JSON.stringify drops a function silently.
// That would map two targets in the same region onto one client, and the second would
// then run with the first one's credentials. They are keyed by object identity in an
// outer WeakMap instead, with the serializable fields keyed inside it.
class ClientCache<T> {
  private readonly withDefaultChain = new Map<string, T>();
  private readonly byCredentials = new WeakMap<object, Map<string, T>>();

  get(config: ClientConfig, create: (config: ClientConfig) => T): T {
    const clients = this.forCredentials(config.credentials);
    const key = configKey(config);
    let client = clients.get(key);
    if (!client) {
      client = create(config);
      clients.set(key, client);
    }
    return client;
  }

  private forCredentials(credentials: AwsCredentials | undefined): Map<string, T> {
    if (!credentials) return this.withDefaultChain;
    let clients = this.byCredentials.get(credentials);
    if (!clients) {
      clients = new Map();
      this.byCredentials.set(credentials, clients);
    }
    return clients;
  }
}

// configKey names the fields that change how a client is constructed. It is built
// field by field rather than by serializing the config, so two callers that list the
// same fields in a different order still map to the same client.
function configKey({ region, endpoint }: ClientConfig): string {
  return JSON.stringify([region, endpoint ?? null]);
}
