import type {
  CreateApiKeyCredentialProviderResponse,
  CreateOauth2CredentialProviderResponse,
  CreateGatewayResponse,
  CreateGatewayRuleResponse,
  CreateGatewayTargetResponse,
  CreateHarnessEndpointRequest,
  CreateHarnessEndpointResponse,
  CreateHarnessResponse,
  DeleteApiKeyCredentialProviderResponse,
  DeleteGatewayResponse,
  DeleteGatewayRuleResponse,
  DeleteGatewayTargetResponse,
  DeleteOauth2CredentialProviderResponse,
  DeleteHarnessEndpointRequest,
  DeleteHarnessEndpointResponse,
  DeleteHarnessRequest,
  DeleteHarnessResponse,
  GetGatewayResponse,
  GetGatewayRuleResponse,
  GetGatewayTargetResponse,
  GetApiKeyCredentialProviderResponse,
  GetOauth2CredentialProviderResponse,
  GetHarnessResponse,
  GetHarnessEndpointResponse,
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  GetMemoryOutput,
  ListApiKeyCredentialProvidersResponse,
  ListOauth2CredentialProvidersResponse,
  ListAgentRuntimeEndpointsResponse,
  ListAgentRuntimesResponse,
  ListAgentRuntimeVersionsResponse,
  ListMemoriesOutput,
  ListHarnessesResponse,
  ListHarnessEndpointsResponse,
  ListHarnessVersionsResponse,
  ListGatewayRulesResponse,
  ListGatewaysResponse,
  ListGatewayTargetsResponse,
  CreateConfigurationBundleResponse,
  CreateDatasetResponse,
  CreateDatasetVersionResponse,
  CreateEvaluatorRequest,
  CreateEvaluatorResponse,
  CreateOnlineEvaluationConfigResponse,
  DeleteConfigurationBundleResponse,
  DeleteDatasetResponse,
  DeleteEvaluatorResponse,
  DeleteOnlineEvaluationConfigResponse,
  GetConfigurationBundleResponse,
  GetConfigurationBundleVersionResponse,
  GetDatasetResponse,
  ListConfigurationBundlesResponse,
  ListConfigurationBundleVersionsResponse,
  ListDatasetsResponse,
  GetEvaluatorResponse,
  GetOnlineEvaluationConfigResponse,
  ListEvaluatorsResponse,
  ListOnlineEvaluationConfigsResponse,
  MemoryView,
  UpdateConfigurationBundleResponse,
  UpdateEvaluatorResponse,
  UpdateOnlineEvaluationConfigResponse,
  UpdateApiKeyCredentialProviderResponse,
  CreatePaymentCredentialProviderResponse,
  DeletePaymentCredentialProviderResponse,
  GetPaymentCredentialProviderResponse,
  UpdatePaymentCredentialProviderResponse,
  UpdateOauth2CredentialProviderResponse,
  UpdateGatewayResponse,
  UpdateGatewayRuleResponse,
  UpdateGatewayTargetResponse,
  UpdateHarnessEndpointRequest,
  UpdateHarnessEndpointResponse,
  UpdateHarnessRequest,
  UpdateHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  GetABTestResponse,
  ListABTestsResponse,
  ABTestExecutionStatus,
  CreateABTestResponse,
  UpdateABTestResponse,
  DeleteABTestResponse,
  DeleteRecommendationResponse,
  GetBatchEvaluationResponse,
  GetRecommendationResponse,
  GetEventInput,
  GetEventOutput,
  GetMemoryRecordInput,
  GetMemoryRecordOutput,
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandResponse,
  InvokeAgentRuntimeCommandStreamOutput,
  InvokeHarnessRequest,
  InvokeHarnessResponse,
  InvokeHarnessStreamOutput,
  ListActorsInput,
  ListActorsOutput,
  ListBatchEvaluationsResponse,
  ListEventsInput,
  ListEventsOutput,
  ListMemoryRecordsInput,
  ListMemoryRecordsOutput,
  ListRecommendationsResponse,
  ListSessionsInput,
  ListSessionsOutput,
  RecommendationStatus,
  StartBatchEvaluationResponse,
  StartRecommendationResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type { Core } from "../handlers/types";
import type { CoreHarnessClient, CreateHarnessInput } from "../handlers/harness/types";
import type {
  CoreGatewayClient,
  CreateGatewayInput,
  CreateGatewayRuleInput,
  CreateGatewayTargetInput,
  GatewayRuleUpdateInput,
  GatewayTargetUpdatePatch,
  GatewayUpdatePatch,
  GatewayInvokeRequest,
  GatewayInvokeResponse,
} from "../handlers/gateway/types";
import type {
  CoreIdentityClient,
  CreateApiKeyCredentialProviderInput,
  CreatePaymentCredentialProviderInput,
  UpdatePaymentCredentialProviderInput,
  CreateOauth2CredentialProviderInput,
  UpdateApiKeyCredentialProviderInput,
  UpdateOauth2CredentialProviderInput,
} from "../handlers/identity/types";
import type { CoreMemoryClient } from "../handlers/memory/types";
import type {
  CloudWatchLogEvent,
  GetTraceQuery,
  InsightsQuery,
  InsightsQueryRow,
  ListTracesQuery,
  LogSearchQuery,
  LogSource,
  LogTailQuery,
  TraceRecord,
  TraceSummary,
} from "../core/observability/types";
import type {
  CoreObservabilityClient,
  CoreRuntimeClient,
  DeployedRuntime,
  RuntimeInvokeRequest,
  RuntimeInvokeResponse,
  RuntimeShellRequest,
  RuntimeShellSession,
} from "../handlers/runtime/types";
import type {
  BatchEvaluationDetail,
  BatchEvaluationResultEntry,
  CodeBasedUpdate,
  CoreEvalClient,
  CreateConfigurationBundleInput,
  CreateConfigBasedABTestInput,
  CreateTargetBasedABTestInput,
  CreateDatasetInput,
  CreateOnlineEvalInput,
  CreateOnlineInsightInput,
  UpdateOnlineInsightInput,
  DatasetUpdateResult,
  DatasetUpdateProgressEvent,
  EvaluateInput,
  EvaluateResult,
  InvokeDatasetInput,
  InvokeDatasetResult,
  GetBatchEvaluationResult,
  GetTracesInput,
  LlmAsAJudgeUpdate,
  SessionTrace,
  StartBatchInsightsInput,
  StartBatchEvaluationInput,
  StartRecommendationInput,
  UpdateConfigurationBundleInput,
  UpdateOnlineEvalInput,
} from "../handlers/eval/types";
import { isTerminalStatus } from "../core/batchEvaluationResults";
import { abortable } from "../core/abortable";
import type { CoreFetch, CoreOptions, CreateCloudFormationClient } from "../core/types";
import type { Project, ProjectManager } from "../handlers/project/types";
import type {
  CorePolicyClient,
  GeneratePolicyInput,
  PolicyGenerationResult,
} from "../handlers/gateway/policy/types";
import type { ProgressEvent } from "../tui/progress";
import type { Logger } from "../logging";
import type { ReadWriteJson } from "../io";
import { createSilentLogger } from "./logging";
import { FsProjectManager, type ProjectBackend } from "../core/project";
import type {
  BedrockAgentImportPlan,
  BedrockAgentImportRequest,
  CoreBedrockAgentImporter,
} from "../core/project/bedrockAgentImport";
import { BEDROCK_AGENT_IMPORT_REGIONS } from "../core/project/bedrockAgentImport";
import type { ManagedBy } from "../projectSchemas/project";
import { InputValidationError } from "../errors";

// TestCoreClient is a hand-controllable `Core` for tests. It implements the same
// interface the real CoreClient satisfies, so it drops straight into
// `createRootHandler(core)` and into a screen's `ScreenProps.core`. Unlike the
// fixture-backed real CoreClient (which exercises src/core end to end), this fake
// is for tests that need to *drive* Core directly: force an error, return a
// specific canned response, or assert on the exact arguments a handler/screen
// passed in.
//
// Configure it per test:
//
//   const core = new TestCoreClient();
//   core.harness.setListResponse({ harnesses: [...] });
//   core.harness.setError(new Error("boom"));           // make the next calls throw
//   core.harness.calls;                                 // inspect recorded calls

// A single recorded call: the method invoked and the arguments it received.
export interface RecordedCall {
  method: string;
  args: unknown[];
}

const DEFAULT_LIST_RESPONSE: ListHarnessesResponse = { harnesses: [] };
const DEFAULT_GET_RESPONSE: GetHarnessResponse = {} as GetHarnessResponse;
const DEFAULT_GET_VERSION_RESPONSE: GetHarnessResponse = {} as GetHarnessResponse;
const DEFAULT_LIST_ENDPOINTS_RESPONSE: ListHarnessEndpointsResponse = { endpoints: [] };
const DEFAULT_LIST_VERSIONS_RESPONSE: ListHarnessVersionsResponse = { harnessVersions: [] };
const DEFAULT_GET_ENDPOINT_RESPONSE: GetHarnessEndpointResponse = {} as GetHarnessEndpointResponse;
const DEFAULT_CREATE_RESPONSE: CreateHarnessResponse = {} as CreateHarnessResponse;
const DEFAULT_UPDATE_RESPONSE: UpdateHarnessResponse = {} as UpdateHarnessResponse;
const DEFAULT_DELETE_RESPONSE: DeleteHarnessResponse = {} as DeleteHarnessResponse;
const DEFAULT_CREATE_ENDPOINT_RESPONSE: CreateHarnessEndpointResponse =
  {} as CreateHarnessEndpointResponse;
const DEFAULT_UPDATE_ENDPOINT_RESPONSE: UpdateHarnessEndpointResponse =
  {} as UpdateHarnessEndpointResponse;
const DEFAULT_DELETE_ENDPOINT_RESPONSE: DeleteHarnessEndpointResponse =
  {} as DeleteHarnessEndpointResponse;
const DEFAULT_CREATE_API_KEY_RESPONSE = {} as CreateApiKeyCredentialProviderResponse;
const DEFAULT_GET_API_KEY_RESPONSE = {} as GetApiKeyCredentialProviderResponse;
const DEFAULT_LIST_API_KEYS_RESPONSE: ListApiKeyCredentialProvidersResponse = {
  credentialProviders: [],
};
const DEFAULT_UPDATE_API_KEY_RESPONSE = {} as UpdateApiKeyCredentialProviderResponse;
const DEFAULT_DELETE_API_KEY_RESPONSE = {} as DeleteApiKeyCredentialProviderResponse;
const DEFAULT_CREATE_PAYMENT_RESPONSE = {} as CreatePaymentCredentialProviderResponse;
const DEFAULT_GET_PAYMENT_RESPONSE = {} as GetPaymentCredentialProviderResponse;
const DEFAULT_UPDATE_PAYMENT_RESPONSE = {} as UpdatePaymentCredentialProviderResponse;
const DEFAULT_DELETE_PAYMENT_RESPONSE = {} as DeletePaymentCredentialProviderResponse;
const DEFAULT_GET_MEMORY_RESPONSE = {} as GetMemoryOutput;
const DEFAULT_LIST_MEMORIES_RESPONSE: ListMemoriesOutput = { memories: [] };
const DEFAULT_GET_EVENT_RESPONSE: GetEventOutput = { event: undefined };
const DEFAULT_LIST_ACTORS_RESPONSE: ListActorsOutput = { actorSummaries: [] };
const DEFAULT_LIST_SESSIONS_RESPONSE: ListSessionsOutput = { sessionSummaries: [] };
const DEFAULT_LIST_EVENTS_RESPONSE: ListEventsOutput = { events: [] };
const DEFAULT_GET_MEMORY_RECORD_RESPONSE: GetMemoryRecordOutput = { memoryRecord: undefined };
const DEFAULT_LIST_MEMORY_RECORDS_RESPONSE: ListMemoryRecordsOutput = {
  memoryRecordSummaries: [],
};
const DEFAULT_CREATE_GATEWAY_RESPONSE = {} as CreateGatewayResponse;
const DEFAULT_UPDATE_GATEWAY_RESPONSE = {} as UpdateGatewayResponse;
const DEFAULT_GET_GATEWAY_RESPONSE = {} as GetGatewayResponse;
const DEFAULT_LIST_GATEWAYS_RESPONSE: ListGatewaysResponse = { items: [] };
const DEFAULT_DELETE_GATEWAY_RESPONSE = {} as DeleteGatewayResponse;
const DEFAULT_CREATE_GATEWAY_TARGET_RESPONSE = {} as CreateGatewayTargetResponse;
const DEFAULT_UPDATE_GATEWAY_TARGET_RESPONSE = {} as UpdateGatewayTargetResponse;
const DEFAULT_GET_GATEWAY_TARGET_RESPONSE = {} as GetGatewayTargetResponse;
const DEFAULT_LIST_GATEWAY_TARGETS_RESPONSE: ListGatewayTargetsResponse = { items: [] };
const DEFAULT_DELETE_GATEWAY_TARGET_RESPONSE = {} as DeleteGatewayTargetResponse;
const DEFAULT_CREATE_GATEWAY_RULE_RESPONSE = {} as CreateGatewayRuleResponse;
const DEFAULT_UPDATE_GATEWAY_RULE_RESPONSE = {} as UpdateGatewayRuleResponse;
const DEFAULT_GET_GATEWAY_RULE_RESPONSE = {} as GetGatewayRuleResponse;
const DEFAULT_LIST_GATEWAY_RULES_RESPONSE: ListGatewayRulesResponse = { gatewayRules: [] };
const DEFAULT_DELETE_GATEWAY_RULE_RESPONSE = {} as DeleteGatewayRuleResponse;
const DEFAULT_CREATE_OAUTH2_RESPONSE = {} as CreateOauth2CredentialProviderResponse;
const DEFAULT_GET_OAUTH2_RESPONSE = {} as GetOauth2CredentialProviderResponse;
const DEFAULT_LIST_OAUTH2_RESPONSE: ListOauth2CredentialProvidersResponse = {
  credentialProviders: [],
};
const DEFAULT_UPDATE_OAUTH2_RESPONSE = {} as UpdateOauth2CredentialProviderResponse;
const DEFAULT_DELETE_OAUTH2_RESPONSE = {} as DeleteOauth2CredentialProviderResponse;
const DEFAULT_GET_RUNTIME_RESPONSE = {} as GetAgentRuntimeResponse;
const DEFAULT_GET_RUNTIME_ENDPOINT_RESPONSE = {} as GetAgentRuntimeEndpointResponse;
const DEFAULT_LIST_RUNTIMES_RESPONSE: ListAgentRuntimesResponse = { agentRuntimes: [] };
const DEFAULT_LIST_RUNTIME_VERSIONS_RESPONSE: ListAgentRuntimeVersionsResponse = {
  agentRuntimes: [],
};
const DEFAULT_LIST_RUNTIME_ENDPOINTS_RESPONSE: ListAgentRuntimeEndpointsResponse = {
  runtimeEndpoints: [],
};
const DEFAULT_CREATE_EVALUATOR_RESPONSE = {} as CreateEvaluatorResponse;
const DEFAULT_UPDATE_EVALUATOR_RESPONSE = {} as UpdateEvaluatorResponse;
const DEFAULT_GET_EVALUATOR_RESPONSE = {} as GetEvaluatorResponse;
const DEFAULT_LIST_EVALUATORS_RESPONSE: ListEvaluatorsResponse = { evaluators: [] };
const DEFAULT_DELETE_EVALUATOR_RESPONSE = {} as DeleteEvaluatorResponse;
const DEFAULT_CREATE_ONLINE_EVAL_RESPONSE = {} as CreateOnlineEvaluationConfigResponse;
const DEFAULT_UPDATE_ONLINE_EVAL_RESPONSE = {} as UpdateOnlineEvaluationConfigResponse;
const DEFAULT_GET_ONLINE_EVAL_RESPONSE = {} as GetOnlineEvaluationConfigResponse;
const DEFAULT_DELETE_ONLINE_EVAL_RESPONSE = {} as DeleteOnlineEvaluationConfigResponse;
const DEFAULT_CREATE_CONFIG_BUNDLE_RESPONSE = {} as CreateConfigurationBundleResponse;
const DEFAULT_GET_CONFIG_BUNDLE_RESPONSE = {} as GetConfigurationBundleResponse;
const DEFAULT_GET_CONFIG_BUNDLE_VERSION_RESPONSE = {} as GetConfigurationBundleVersionResponse;
const DEFAULT_LIST_CONFIG_BUNDLES_RESPONSE: ListConfigurationBundlesResponse = { bundles: [] };
const DEFAULT_UPDATE_CONFIG_BUNDLE_RESPONSE = {} as UpdateConfigurationBundleResponse;
const DEFAULT_DELETE_CONFIG_BUNDLE_RESPONSE = {} as DeleteConfigurationBundleResponse;
const DEFAULT_LIST_CONFIG_BUNDLE_VERSIONS_RESPONSE: ListConfigurationBundleVersionsResponse = {
  versions: [],
};
const DEFAULT_CREATE_DATASET_RESPONSE = {} as CreateDatasetResponse;
const DEFAULT_GET_DATASET_RESPONSE = {} as GetDatasetResponse;
const DEFAULT_LIST_DATASETS_RESPONSE: ListDatasetsResponse = { datasets: [] };
const DEFAULT_DELETE_DATASET_RESPONSE = {} as DeleteDatasetResponse;
const DEFAULT_PUBLISH_DATASET_RESPONSE = {} as CreateDatasetVersionResponse;
const DEFAULT_GET_BATCH_EVAL_RESPONSE = {} as GetBatchEvaluationResponse;
const DEFAULT_LIST_BATCH_EVALS_RESPONSE: ListBatchEvaluationsResponse = { batchEvaluations: [] };
const DEFAULT_GET_ABTEST_RESPONSE = {} as GetABTestResponse;
const DEFAULT_LIST_ABTESTS_RESPONSE: ListABTestsResponse = { abTests: [] };
const DEFAULT_UPDATE_ABTEST_RESPONSE = {} as UpdateABTestResponse;
const DEFAULT_DELETE_ABTEST_RESPONSE = {} as DeleteABTestResponse;
const DEFAULT_CREATE_ABTEST_RESPONSE = {} as CreateABTestResponse;
const DEFAULT_START_BATCH_EVAL_RESPONSE = {
  batchEvaluationId: "batch-eval-test",
  status: "RUNNING",
} as unknown as StartBatchEvaluationResponse;
const DEFAULT_START_RECOMMENDATION_RESPONSE = {} as StartRecommendationResponse;
const DEFAULT_GET_RECOMMENDATION_RESPONSE = {} as GetRecommendationResponse;
const DEFAULT_LIST_RECOMMENDATIONS_RESPONSE: ListRecommendationsResponse = {
  recommendationSummaries: [],
};
const DEFAULT_DELETE_RECOMMENDATION_RESPONSE = {} as DeleteRecommendationResponse;
const DEFAULT_UPDATE_DATASET_RESULT: DatasetUpdateResult = {
  datasetId: "dataset-orders-abc123",
  added: 0,
  updated: 0,
  deleted: 0,
  unchanged: 0,
};

// events wraps canned events as a one-shot AsyncIterable.
async function* events<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const DEFAULT_RUNTIME_INVOKE_RESPONSE: RuntimeInvokeResponse = {
  statusCode: 200,
  contentType: "application/json",
  body: events([]),
};
const DEFAULT_GATEWAY_INVOKE_RESPONSE: GatewayInvokeResponse = {
  statusCode: 200,
  contentType: "application/json",
  body: events([]),
};

// TestHarnessClient is the harness sub-client of TestCoreClient.
export class TestHarnessClient implements CoreHarnessClient {
  // calls records every invocation in order, for assertions.
  readonly calls: RecordedCall[] = [];

  // List responses are keyed by the nextToken that requests them (undefined =
  // the first page), so tests can serve multi-page listings.
  private listResponses = new Map<string | undefined, ListHarnessesResponse>();
  private getResponse: GetHarnessResponse = DEFAULT_GET_RESPONSE;
  private getVersionResponse: GetHarnessResponse = DEFAULT_GET_VERSION_RESPONSE;
  private getEndpointResponse: GetHarnessEndpointResponse = DEFAULT_GET_ENDPOINT_RESPONSE;
  private listEndpointsResponses = new Map<string | undefined, ListHarnessEndpointsResponse>();
  private listVersionsResponses = new Map<string | undefined, ListHarnessVersionsResponse>();
  private invokeEvents: InvokeHarnessStreamOutput[] = [];
  private invokeStreams: AsyncIterable<InvokeHarnessStreamOutput>[] = [];
  private execEvents: InvokeAgentRuntimeCommandStreamOutput[] = [];
  private execStreams: AsyncIterable<InvokeAgentRuntimeCommandStreamOutput>[] = [];
  private createResponse: CreateHarnessResponse = DEFAULT_CREATE_RESPONSE;
  private updateResponse: UpdateHarnessResponse = DEFAULT_UPDATE_RESPONSE;
  private deleteResponse: DeleteHarnessResponse = DEFAULT_DELETE_RESPONSE;
  private createEndpointResponse: CreateHarnessEndpointResponse = DEFAULT_CREATE_ENDPOINT_RESPONSE;
  private updateEndpointResponse: UpdateHarnessEndpointResponse = DEFAULT_UPDATE_ENDPOINT_RESPONSE;
  private deleteEndpointResponse: DeleteHarnessEndpointResponse = DEFAULT_DELETE_ENDPOINT_RESPONSE;
  private error?: Error;

  // setListResponse sets what listHarnesses resolves to (when not erroring).
  // Pass `forNextToken` to serve a later page: the response is returned when
  // listHarnesses is called with that nextToken.
  setListResponse(response: ListHarnessesResponse, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
    return this;
  }

  // setGetResponse sets what getHarness resolves to (when not erroring).
  setGetResponse(response: GetHarnessResponse): this {
    this.getResponse = response;
    return this;
  }

  // setGetVersionResponse sets what getHarnessVersion resolves to (when not
  // erroring).
  setGetVersionResponse(response: GetHarnessResponse): this {
    this.getVersionResponse = response;
    return this;
  }

  // setGetEndpointResponse sets what getHarnessEndpoint resolves to (when not
  // erroring).
  setGetEndpointResponse(response: GetHarnessEndpointResponse): this {
    this.getEndpointResponse = response;
    return this;
  }

  // setListEndpointsResponse sets what listHarnessEndpoints resolves to (when
  // not erroring). Pass `forNextToken` to serve a later page.
  setListEndpointsResponse(response: ListHarnessEndpointsResponse, forNextToken?: string): this {
    this.listEndpointsResponses.set(forNextToken, response);
    return this;
  }

  // setListVersionsResponse sets what listHarnessVersions resolves to (when not
  // erroring). Pass `forNextToken` to serve a later page.
  setListVersionsResponse(response: ListHarnessVersionsResponse, forNextToken?: string): this {
    this.listVersionsResponses.set(forNextToken, response);
    return this;
  }

  // setInvokeEvents sets the canned full turn every invokeHarness call streams
  // (unless a queued stream takes precedence).
  setInvokeEvents(...events: InvokeHarnessStreamOutput[]): this {
    this.invokeEvents = events;
    return this;
  }

  // queueInvokeStream enqueues a stream for a single invokeHarness call; calls
  // consume the queue in FIFO order before falling back to the canned events.
  // Pass a StreamController to hold the stream open and pump it by hand.
  queueInvokeStream(stream: AsyncIterable<InvokeHarnessStreamOutput>): this {
    this.invokeStreams.push(stream);
    return this;
  }

  // setExecEvents sets the canned stream every invokeAgentRuntimeCommand call
  // yields (unless a queued stream takes precedence).
  setExecEvents(...events: InvokeAgentRuntimeCommandStreamOutput[]): this {
    this.execEvents = events;
    return this;
  }

  // queueExecStream enqueues a stream for a single invokeAgentRuntimeCommand
  // call, FIFO before the canned events — same contract as queueInvokeStream.
  queueExecStream(stream: AsyncIterable<InvokeAgentRuntimeCommandStreamOutput>): this {
    this.execStreams.push(stream);
    return this;
  }

  // setCreateResponse sets what createHarness resolves to (when not erroring).
  setCreateResponse(response: CreateHarnessResponse): this {
    this.createResponse = response;
    return this;
  }

  // setUpdateResponse sets what updateHarness resolves to (when not erroring).
  setUpdateResponse(response: UpdateHarnessResponse): this {
    this.updateResponse = response;
    return this;
  }

  // setDeleteResponse sets what deleteHarness resolves to (when not erroring).
  setDeleteResponse(response: DeleteHarnessResponse): this {
    this.deleteResponse = response;
    return this;
  }

  // setCreateEndpointResponse sets what createHarnessEndpoint resolves to (when
  // not erroring).
  setCreateEndpointResponse(response: CreateHarnessEndpointResponse): this {
    this.createEndpointResponse = response;
    return this;
  }

  // setUpdateEndpointResponse sets what updateHarnessEndpoint resolves to (when
  // not erroring).
  setUpdateEndpointResponse(response: UpdateHarnessEndpointResponse): this {
    this.updateEndpointResponse = response;
    return this;
  }

  // setDeleteEndpointResponse sets what deleteHarnessEndpoint resolves to (when
  // not erroring).
  setDeleteEndpointResponse(response: DeleteHarnessEndpointResponse): this {
    this.deleteEndpointResponse = response;
    return this;
  }

  // setError makes every subsequent call reject with `error`. Pass undefined to
  // clear it.
  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async createHarness(
    input: CreateHarnessInput,
    options: CoreOptions,
  ): Promise<CreateHarnessResponse> {
    this.calls.push({ method: "createHarness", args: [input, options] });
    if (this.error) throw this.error;
    return this.createResponse;
  }

  async updateHarness(
    request: UpdateHarnessRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessResponse> {
    this.calls.push({ method: "updateHarness", args: [request, options] });
    if (this.error) throw this.error;
    return this.updateResponse;
  }

  async deleteHarness(
    request: DeleteHarnessRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessResponse> {
    this.calls.push({ method: "deleteHarness", args: [request, options] });
    if (this.error) throw this.error;
    return this.deleteResponse;
  }

  async createHarnessEndpoint(
    request: CreateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<CreateHarnessEndpointResponse> {
    this.calls.push({ method: "createHarnessEndpoint", args: [request, options] });
    if (this.error) throw this.error;
    return this.createEndpointResponse;
  }

  async updateHarnessEndpoint(
    request: UpdateHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<UpdateHarnessEndpointResponse> {
    this.calls.push({ method: "updateHarnessEndpoint", args: [request, options] });
    if (this.error) throw this.error;
    return this.updateEndpointResponse;
  }

  async deleteHarnessEndpoint(
    request: DeleteHarnessEndpointRequest,
    options: CoreOptions,
  ): Promise<DeleteHarnessEndpointResponse> {
    this.calls.push({ method: "deleteHarnessEndpoint", args: [request, options] });
    if (this.error) throw this.error;
    return this.deleteEndpointResponse;
  }

  async getHarness(id: string, options: CoreOptions): Promise<GetHarnessResponse> {
    this.calls.push({ method: "getHarness", args: [id, options] });
    if (this.error) throw this.error;
    return this.getResponse;
  }

  async getHarnessVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetHarnessResponse> {
    this.calls.push({ method: "getHarnessVersion", args: [id, version, options] });
    if (this.error) throw this.error;
    return this.getVersionResponse;
  }

  async getHarnessEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetHarnessEndpointResponse> {
    this.calls.push({ method: "getHarnessEndpoint", args: [id, qualifier, options] });
    if (this.error) throw this.error;
    return this.getEndpointResponse;
  }

  async listHarnesses(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessesResponse> {
    this.calls.push({ method: "listHarnesses", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.listResponses.get(nextToken) ??
      this.listResponses.get(undefined) ??
      DEFAULT_LIST_RESPONSE
    );
  }

  async listHarnessEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessEndpointsResponse> {
    this.calls.push({
      method: "listHarnessEndpoints",
      args: [id, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listEndpointsResponses.get(nextToken) ??
      this.listEndpointsResponses.get(undefined) ??
      DEFAULT_LIST_ENDPOINTS_RESPONSE
    );
  }

  async listHarnessVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListHarnessVersionsResponse> {
    this.calls.push({
      method: "listHarnessVersions",
      args: [id, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listVersionsResponses.get(nextToken) ??
      this.listVersionsResponses.get(undefined) ??
      DEFAULT_LIST_VERSIONS_RESPONSE
    );
  }

  async invokeHarness(
    request: InvokeHarnessRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeHarnessResponse> {
    this.calls.push({ method: "invokeHarness", args: [request, options, abortSignal] });
    if (this.error) throw this.error;
    const stream = this.invokeStreams.shift() ?? events(this.invokeEvents);
    return { stream: abortSignal ? abortable(stream, abortSignal) : stream };
  }

  async invokeAgentRuntimeCommand(
    request: InvokeAgentRuntimeCommandRequest,
    options: CoreOptions,
    abortSignal?: AbortSignal,
  ): Promise<InvokeAgentRuntimeCommandResponse> {
    this.calls.push({
      method: "invokeAgentRuntimeCommand",
      args: [request, options, abortSignal],
    });
    if (this.error) throw this.error;
    const stream = this.execStreams.shift() ?? events(this.execEvents);
    return {
      contentType: "application/json",
      statusCode: 200,
      runtimeSessionId: request.runtimeSessionId,
      stream: abortSignal ? abortable(stream, abortSignal) : stream,
    };
  }
}

export class TestRuntimeClient implements CoreRuntimeClient {
  readonly calls: RecordedCall[] = [];

  private getResponse: GetAgentRuntimeResponse = DEFAULT_GET_RUNTIME_RESPONSE;
  private getVersionResponse: GetAgentRuntimeResponse = DEFAULT_GET_RUNTIME_RESPONSE;
  private getEndpointResponse: GetAgentRuntimeEndpointResponse =
    DEFAULT_GET_RUNTIME_ENDPOINT_RESPONSE;
  private listResponses = new Map<string | undefined, ListAgentRuntimesResponse>();
  private listVersionResponses = new Map<string | undefined, ListAgentRuntimeVersionsResponse>();
  private listEndpointResponses = new Map<string | undefined, ListAgentRuntimeEndpointsResponse>();
  private invokeResponse: RuntimeInvokeResponse = DEFAULT_RUNTIME_INVOKE_RESPONSE;
  private invokeBodies: AsyncIterable<Uint8Array>[] = [];
  private shellSession: RuntimeShellSession = {
    runtimeSessionId: "runtime-session-012345678901234567890123",
    kicked: false,
    exitCode: 0,
    send: async () => {},
    resize: async () => {},
    close: async () => {},
    async *[Symbol.asyncIterator]() {},
  };
  private error?: Error;

  setGetResponse(response: GetAgentRuntimeResponse): this {
    this.getResponse = response;
    return this;
  }

  setGetVersionResponse(response: GetAgentRuntimeResponse): this {
    this.getVersionResponse = response;
    return this;
  }

  setGetEndpointResponse(response: GetAgentRuntimeEndpointResponse): this {
    this.getEndpointResponse = response;
    return this;
  }

  setListResponse(response: ListAgentRuntimesResponse, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
    return this;
  }

  setListVersionsResponse(response: ListAgentRuntimeVersionsResponse, forNextToken?: string): this {
    this.listVersionResponses.set(forNextToken, response);
    return this;
  }

  setListEndpointsResponse(
    response: ListAgentRuntimeEndpointsResponse,
    forNextToken?: string,
  ): this {
    this.listEndpointResponses.set(forNextToken, response);
    return this;
  }

  setInvokeResponse(response: RuntimeInvokeResponse): this {
    this.invokeResponse = response;
    return this;
  }

  setShellSession(session: RuntimeShellSession): this {
    this.shellSession = session;
    return this;
  }

  queueInvokeBody(body: AsyncIterable<Uint8Array>): this {
    this.invokeBodies.push(body);
    return this;
  }

  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async getRuntime(
    id: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetAgentRuntimeResponse> {
    this.calls.push({ method: "getRuntime", args: [id, options, ...(signal ? [signal] : [])] });
    if (this.error) throw this.error;
    return this.getResponse;
  }

  async invokeRuntime(
    request: RuntimeInvokeRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeInvokeResponse> {
    this.calls.push({ method: "invokeRuntime", args: [request, options, signal] });
    if (this.error) throw this.error;
    return {
      ...this.invokeResponse,
      body: this.invokeBodies.shift() ?? this.invokeResponse.body,
    };
  }

  async openRuntimeShell(
    request: RuntimeShellRequest,
    options: CoreOptions,
  ): Promise<RuntimeShellSession> {
    this.calls.push({ method: "openRuntimeShell", args: [request, options] });
    if (this.error) throw this.error;
    return this.shellSession;
  }

  async getRuntimeVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeResponse> {
    this.calls.push({ method: "getRuntimeVersion", args: [id, version, options] });
    if (this.error) throw this.error;
    return this.getVersionResponse;
  }

  async getRuntimeEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeEndpointResponse> {
    this.calls.push({ method: "getRuntimeEndpoint", args: [id, qualifier, options] });
    if (this.error) throw this.error;
    return this.getEndpointResponse;
  }

  async listRuntimes(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimesResponse> {
    this.calls.push({ method: "listRuntimes", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.listResponses.get(nextToken) ??
      this.listResponses.get(undefined) ??
      DEFAULT_LIST_RUNTIMES_RESPONSE
    );
  }

  async listRuntimeVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeVersionsResponse> {
    this.calls.push({
      method: "listRuntimeVersions",
      args: [id, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listVersionResponses.get(nextToken) ??
      this.listVersionResponses.get(undefined) ??
      DEFAULT_LIST_RUNTIME_VERSIONS_RESPONSE
    );
  }

  async listRuntimeEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeEndpointsResponse> {
    this.calls.push({
      method: "listRuntimeEndpoints",
      args: [id, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listEndpointResponses.get(nextToken) ??
      this.listEndpointResponses.get(undefined) ??
      DEFAULT_LIST_RUNTIME_ENDPOINTS_RESPONSE
    );
  }
}

export class TestMemoryClient implements CoreMemoryClient {
  readonly calls: RecordedCall[] = [];

  private getResponse: GetMemoryOutput = DEFAULT_GET_MEMORY_RESPONSE;
  private listResponses = new Map<string | undefined, ListMemoriesOutput>();
  private getEventResponse: GetEventOutput = DEFAULT_GET_EVENT_RESPONSE;
  private listActorResponses = new Map<string | undefined, ListActorsOutput>();
  private listSessionResponses = new Map<string | undefined, ListSessionsOutput>();
  private listEventResponses = new Map<string | undefined, ListEventsOutput>();
  private getMemoryRecordResponse: GetMemoryRecordOutput = DEFAULT_GET_MEMORY_RECORD_RESPONSE;
  private listMemoryRecordResponses = new Map<string | undefined, ListMemoryRecordsOutput>();
  private error?: Error;

  setGetResponse(response: GetMemoryOutput): this {
    this.getResponse = response;
    return this;
  }

  setListResponse(response: ListMemoriesOutput, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
    return this;
  }

  setGetEventResponse(response: GetEventOutput): this {
    this.getEventResponse = response;
    return this;
  }

  setListActorsResponse(response: ListActorsOutput, forNextToken?: string): this {
    this.listActorResponses.set(forNextToken, response);
    return this;
  }

  setListSessionsResponse(response: ListSessionsOutput, forNextToken?: string): this {
    this.listSessionResponses.set(forNextToken, response);
    return this;
  }

  setListEventsResponse(response: ListEventsOutput, forNextToken?: string): this {
    this.listEventResponses.set(forNextToken, response);
    return this;
  }

  setGetMemoryRecordResponse(response: GetMemoryRecordOutput): this {
    this.getMemoryRecordResponse = response;
    return this;
  }

  setListMemoryRecordsResponse(response: ListMemoryRecordsOutput, forNextToken?: string): this {
    this.listMemoryRecordResponses.set(forNextToken, response);
    return this;
  }

  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async getMemory(id: string, view: MemoryView, options: CoreOptions): Promise<GetMemoryOutput> {
    this.calls.push({ method: "getMemory", args: [id, view, options] });
    if (this.error) throw this.error;
    return this.getResponse;
  }

  async listMemories(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListMemoriesOutput> {
    this.calls.push({ method: "listMemories", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.listResponses.get(nextToken) ??
      this.listResponses.get(undefined) ??
      DEFAULT_LIST_MEMORIES_RESPONSE
    );
  }

  async getEvent(input: GetEventInput, options: CoreOptions): Promise<GetEventOutput> {
    this.calls.push({ method: "getEvent", args: [input, options] });
    if (this.error) throw this.error;
    return this.getEventResponse;
  }

  async listActors(input: ListActorsInput, options: CoreOptions): Promise<ListActorsOutput> {
    this.calls.push({ method: "listActors", args: [input, options] });
    if (this.error) throw this.error;
    return (
      this.listActorResponses.get(input.nextToken) ??
      this.listActorResponses.get(undefined) ??
      DEFAULT_LIST_ACTORS_RESPONSE
    );
  }

  async listSessions(input: ListSessionsInput, options: CoreOptions): Promise<ListSessionsOutput> {
    this.calls.push({ method: "listSessions", args: [input, options] });
    if (this.error) throw this.error;
    return (
      this.listSessionResponses.get(input.nextToken) ??
      this.listSessionResponses.get(undefined) ??
      DEFAULT_LIST_SESSIONS_RESPONSE
    );
  }

  async listEvents(input: ListEventsInput, options: CoreOptions): Promise<ListEventsOutput> {
    this.calls.push({ method: "listEvents", args: [input, options] });
    if (this.error) throw this.error;
    return (
      this.listEventResponses.get(input.nextToken) ??
      this.listEventResponses.get(undefined) ??
      DEFAULT_LIST_EVENTS_RESPONSE
    );
  }

  async getMemoryRecord(
    input: GetMemoryRecordInput,
    options: CoreOptions,
  ): Promise<GetMemoryRecordOutput> {
    this.calls.push({ method: "getMemoryRecord", args: [input, options] });
    if (this.error) throw this.error;
    return this.getMemoryRecordResponse;
  }

  async listMemoryRecords(
    input: ListMemoryRecordsInput,
    options: CoreOptions,
  ): Promise<ListMemoryRecordsOutput> {
    this.calls.push({ method: "listMemoryRecords", args: [input, options] });
    if (this.error) throw this.error;
    return (
      this.listMemoryRecordResponses.get(input.nextToken) ??
      this.listMemoryRecordResponses.get(undefined) ??
      DEFAULT_LIST_MEMORY_RECORDS_RESPONSE
    );
  }
}

export class TestGatewayClient implements CoreGatewayClient {
  readonly calls: RecordedCall[] = [];

  private getResponse: GetGatewayResponse = DEFAULT_GET_GATEWAY_RESPONSE;
  private listResponses = new Map<string | undefined, ListGatewaysResponse>();
  private deleteResponse: DeleteGatewayResponse = DEFAULT_DELETE_GATEWAY_RESPONSE;
  private getTargetResponse: GetGatewayTargetResponse = DEFAULT_GET_GATEWAY_TARGET_RESPONSE;
  private listTargetResponses = new Map<string | undefined, ListGatewayTargetsResponse>();
  private getConnectorResponse: GetGatewayTargetResponse = DEFAULT_GET_GATEWAY_TARGET_RESPONSE;
  private listConnectorResponses = new Map<string | undefined, ListGatewayTargetsResponse>();
  private deleteTargetResponse: DeleteGatewayTargetResponse =
    DEFAULT_DELETE_GATEWAY_TARGET_RESPONSE;
  private getRuleResponse: GetGatewayRuleResponse = DEFAULT_GET_GATEWAY_RULE_RESPONSE;
  private listRuleResponses = new Map<string | undefined, ListGatewayRulesResponse>();
  private deleteRuleResponse: DeleteGatewayRuleResponse = DEFAULT_DELETE_GATEWAY_RULE_RESPONSE;
  private invokeResponse: GatewayInvokeResponse = DEFAULT_GATEWAY_INVOKE_RESPONSE;
  private error?: Error;

  setGetResponse(response: GetGatewayResponse): this {
    this.getResponse = response;
    return this;
  }

  setListResponse(response: ListGatewaysResponse, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
    return this;
  }

  setDeleteResponse(response: DeleteGatewayResponse): this {
    this.deleteResponse = response;
    return this;
  }

  setGetTargetResponse(response: GetGatewayTargetResponse): this {
    this.getTargetResponse = response;
    return this;
  }

  setListTargetsResponse(response: ListGatewayTargetsResponse, forNextToken?: string): this {
    this.listTargetResponses.set(forNextToken, response);
    return this;
  }

  setGetConnectorResponse(response: GetGatewayTargetResponse): this {
    this.getConnectorResponse = response;
    return this;
  }

  setListConnectorsResponse(response: ListGatewayTargetsResponse, forNextToken?: string): this {
    this.listConnectorResponses.set(forNextToken, response);
    return this;
  }

  setDeleteTargetResponse(response: DeleteGatewayTargetResponse): this {
    this.deleteTargetResponse = response;
    return this;
  }

  setGetRuleResponse(response: GetGatewayRuleResponse): this {
    this.getRuleResponse = response;
    return this;
  }

  setListRulesResponse(response: ListGatewayRulesResponse, forNextToken?: string): this {
    this.listRuleResponses.set(forNextToken, response);
    return this;
  }

  setDeleteRuleResponse(response: DeleteGatewayRuleResponse): this {
    this.deleteRuleResponse = response;
    return this;
  }

  setInvokeResponse(response: GatewayInvokeResponse): this {
    this.invokeResponse = response;
    return this;
  }

  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async createGateway(
    input: CreateGatewayInput,
    options: CoreOptions,
  ): Promise<CreateGatewayResponse> {
    this.calls.push({ method: "createGateway", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_CREATE_GATEWAY_RESPONSE;
  }

  async updateGateway(
    patch: GatewayUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayResponse> {
    this.calls.push({ method: "updateGateway", args: [patch, options] });
    if (this.error) throw this.error;
    return DEFAULT_UPDATE_GATEWAY_RESPONSE;
  }

  async invokeGateway(
    request: GatewayInvokeRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GatewayInvokeResponse> {
    this.calls.push({ method: "invokeGateway", args: [request, options, signal] });
    if (this.error) throw this.error;
    return this.invokeResponse;
  }

  async getGateway(
    id: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetGatewayResponse> {
    this.calls.push({
      method: "getGateway",
      args: [id, options, ...(signal ? [signal] : [])],
    });
    if (this.error) throw this.error;
    return this.getResponse;
  }

  async listGateways(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewaysResponse> {
    this.calls.push({ method: "listGateways", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.listResponses.get(nextToken) ??
      this.listResponses.get(undefined) ??
      DEFAULT_LIST_GATEWAYS_RESPONSE
    );
  }

  async deleteGateway(id: string, options: CoreOptions): Promise<DeleteGatewayResponse> {
    this.calls.push({ method: "deleteGateway", args: [id, options] });
    if (this.error) throw this.error;
    return this.deleteResponse;
  }

  async createGatewayTarget(
    input: CreateGatewayTargetInput,
    options: CoreOptions,
  ): Promise<CreateGatewayTargetResponse> {
    this.calls.push({ method: "createGatewayTarget", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_CREATE_GATEWAY_TARGET_RESPONSE;
  }

  async updateGatewayTarget(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse> {
    this.calls.push({ method: "updateGatewayTarget", args: [patch, options] });
    if (this.error) throw this.error;
    return DEFAULT_UPDATE_GATEWAY_TARGET_RESPONSE;
  }

  async updateGatewayConnector(
    patch: GatewayTargetUpdatePatch,
    options: CoreOptions,
  ): Promise<UpdateGatewayTargetResponse> {
    this.calls.push({ method: "updateGatewayConnector", args: [patch, options] });
    if (this.error) throw this.error;
    return DEFAULT_UPDATE_GATEWAY_TARGET_RESPONSE;
  }

  async getGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    this.calls.push({ method: "getGatewayTarget", args: [gatewayId, targetId, options] });
    if (this.error) throw this.error;
    return this.getTargetResponse;
  }

  async listGatewayTargets(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    this.calls.push({
      method: "listGatewayTargets",
      args: [gatewayId, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listTargetResponses.get(nextToken) ??
      this.listTargetResponses.get(undefined) ??
      DEFAULT_LIST_GATEWAY_TARGETS_RESPONSE
    );
  }

  async getGatewayConnector(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    this.calls.push({ method: "getGatewayConnector", args: [gatewayId, targetId, options] });
    if (this.error) throw this.error;
    return this.getConnectorResponse;
  }

  async listGatewayConnectors(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    this.calls.push({
      method: "listGatewayConnectors",
      args: [gatewayId, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listConnectorResponses.get(nextToken) ??
      this.listConnectorResponses.get(undefined) ??
      DEFAULT_LIST_GATEWAY_TARGETS_RESPONSE
    );
  }

  async deleteGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayTargetResponse> {
    this.calls.push({ method: "deleteGatewayTarget", args: [gatewayId, targetId, options] });
    if (this.error) throw this.error;
    return this.deleteTargetResponse;
  }

  async createGatewayRule(
    input: CreateGatewayRuleInput,
    options: CoreOptions,
  ): Promise<CreateGatewayRuleResponse> {
    this.calls.push({ method: "createGatewayRule", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_CREATE_GATEWAY_RULE_RESPONSE;
  }

  async updateGatewayRule(
    input: GatewayRuleUpdateInput,
    options: CoreOptions,
  ): Promise<UpdateGatewayRuleResponse> {
    this.calls.push({ method: "updateGatewayRule", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_UPDATE_GATEWAY_RULE_RESPONSE;
  }

  async getGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<GetGatewayRuleResponse> {
    this.calls.push({ method: "getGatewayRule", args: [gatewayId, ruleId, options] });
    if (this.error) throw this.error;
    return this.getRuleResponse;
  }

  async listGatewayRules(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayRulesResponse> {
    this.calls.push({
      method: "listGatewayRules",
      args: [gatewayId, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listRuleResponses.get(nextToken) ??
      this.listRuleResponses.get(undefined) ??
      DEFAULT_LIST_GATEWAY_RULES_RESPONSE
    );
  }
  async deleteGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<DeleteGatewayRuleResponse> {
    this.calls.push({ method: "deleteGatewayRule", args: [gatewayId, ruleId, options] });
    if (this.error) throw this.error;
    return this.deleteRuleResponse;
  }
}

type TestCoreClientOptions = {
  logger?: Logger;
  json?: ReadWriteJson;
  backends?: Partial<Record<ManagedBy, ProjectBackend>>;
  createCloudFormationClient?: CreateCloudFormationClient;
  resolveAccount?: (region: string) => Promise<string>;
};

export class TestIdentityClient implements CoreIdentityClient {
  readonly calls: RecordedCall[] = [];

  private getApiKeyResponse: GetApiKeyCredentialProviderResponse = DEFAULT_GET_API_KEY_RESPONSE;
  private listApiKeyResponses = new Map<
    string | undefined,
    ListApiKeyCredentialProvidersResponse
  >();
  private getOauth2Response: GetOauth2CredentialProviderResponse = DEFAULT_GET_OAUTH2_RESPONSE;
  private listOauth2Responses = new Map<
    string | undefined,
    ListOauth2CredentialProvidersResponse
  >();
  private updateOauth2Response: UpdateOauth2CredentialProviderResponse =
    DEFAULT_UPDATE_OAUTH2_RESPONSE;
  private getPaymentResponse: GetPaymentCredentialProviderResponse = DEFAULT_GET_PAYMENT_RESPONSE;
  private error?: Error;

  setGetPaymentResponse(response: GetPaymentCredentialProviderResponse): this {
    this.getPaymentResponse = response;
    return this;
  }

  setGetApiKeyResponse(response: GetApiKeyCredentialProviderResponse): this {
    this.getApiKeyResponse = response;
    return this;
  }

  setListApiKeyResponse(
    response: ListApiKeyCredentialProvidersResponse,
    forNextToken?: string,
  ): this {
    this.listApiKeyResponses.set(forNextToken, response);
    return this;
  }

  setGetOauth2Response(response: GetOauth2CredentialProviderResponse): this {
    this.getOauth2Response = response;
    return this;
  }

  setUpdateOauth2Response(response: UpdateOauth2CredentialProviderResponse): this {
    this.updateOauth2Response = response;
    return this;
  }

  setListOauth2Response(
    response: ListOauth2CredentialProvidersResponse,
    forNextToken?: string,
  ): this {
    this.listOauth2Responses.set(forNextToken, response);
    return this;
  }

  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async createApiKeyCredentialProvider(
    input: CreateApiKeyCredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreateApiKeyCredentialProviderResponse> {
    this.calls.push({ method: "createApiKeyCredentialProvider", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_CREATE_API_KEY_RESPONSE;
  }

  async getApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetApiKeyCredentialProviderResponse> {
    this.calls.push({ method: "getApiKeyCredentialProvider", args: [name, options] });
    if (this.error) throw this.error;
    return this.getApiKeyResponse;
  }

  async listApiKeyCredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListApiKeyCredentialProvidersResponse> {
    this.calls.push({
      method: "listApiKeyCredentialProviders",
      args: [nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listApiKeyResponses.get(nextToken) ??
      this.listApiKeyResponses.get(undefined) ??
      DEFAULT_LIST_API_KEYS_RESPONSE
    );
  }

  async updateApiKeyCredentialProvider(
    input: UpdateApiKeyCredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdateApiKeyCredentialProviderResponse> {
    this.calls.push({ method: "updateApiKeyCredentialProvider", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_UPDATE_API_KEY_RESPONSE;
  }

  async deleteApiKeyCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteApiKeyCredentialProviderResponse> {
    this.calls.push({ method: "deleteApiKeyCredentialProvider", args: [name, options] });
    if (this.error) throw this.error;
    return DEFAULT_DELETE_API_KEY_RESPONSE;
  }

  async createOauth2CredentialProvider(
    input: CreateOauth2CredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreateOauth2CredentialProviderResponse> {
    this.calls.push({ method: "createOauth2CredentialProvider", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_CREATE_OAUTH2_RESPONSE;
  }

  async getOauth2CredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetOauth2CredentialProviderResponse> {
    this.calls.push({ method: "getOauth2CredentialProvider", args: [name, options] });
    if (this.error) throw this.error;
    return this.getOauth2Response;
  }

  async listOauth2CredentialProviders(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOauth2CredentialProvidersResponse> {
    this.calls.push({
      method: "listOauth2CredentialProviders",
      args: [nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.listOauth2Responses.get(nextToken) ??
      this.listOauth2Responses.get(undefined) ??
      DEFAULT_LIST_OAUTH2_RESPONSE
    );
  }

  async updateOauth2CredentialProvider(
    input: UpdateOauth2CredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdateOauth2CredentialProviderResponse> {
    this.calls.push({ method: "updateOauth2CredentialProvider", args: [input, options] });
    if (this.error) throw this.error;
    return this.updateOauth2Response;
  }

  async deleteOauth2CredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeleteOauth2CredentialProviderResponse> {
    this.calls.push({ method: "deleteOauth2CredentialProvider", args: [name, options] });
    if (this.error) throw this.error;
    return DEFAULT_DELETE_OAUTH2_RESPONSE;
  }

  async createPaymentCredentialProvider(
    input: CreatePaymentCredentialProviderInput,
    options: CoreOptions,
  ): Promise<CreatePaymentCredentialProviderResponse> {
    this.calls.push({ method: "createPaymentCredentialProvider", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_CREATE_PAYMENT_RESPONSE;
  }

  async getPaymentCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<GetPaymentCredentialProviderResponse> {
    this.calls.push({ method: "getPaymentCredentialProvider", args: [name, options] });
    if (this.error) throw this.error;
    return this.getPaymentResponse;
  }

  async updatePaymentCredentialProvider(
    input: UpdatePaymentCredentialProviderInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentCredentialProviderResponse> {
    this.calls.push({ method: "updatePaymentCredentialProvider", args: [input, options] });
    if (this.error) throw this.error;
    return DEFAULT_UPDATE_PAYMENT_RESPONSE;
  }

  async deletePaymentCredentialProvider(
    name: string,
    options: CoreOptions,
  ): Promise<DeletePaymentCredentialProviderResponse> {
    this.calls.push({ method: "deletePaymentCredentialProvider", args: [name, options] });
    if (this.error) throw this.error;
    return DEFAULT_DELETE_PAYMENT_RESPONSE;
  }
}

// TestEvalClient is the eval sub-client of TestCoreClient.
export class TestEvalClient implements CoreEvalClient {
  // calls records every invocation in order, for assertions.
  readonly calls: RecordedCall[] = [];

  // List responses are keyed by the nextToken that requests them (undefined =
  // the first page), so tests can serve multi-page listings.
  private listResponses = new Map<string | undefined, ListEvaluatorsResponse>();
  private createResponse: CreateEvaluatorResponse = DEFAULT_CREATE_EVALUATOR_RESPONSE;
  private updateResponse: UpdateEvaluatorResponse = DEFAULT_UPDATE_EVALUATOR_RESPONSE;
  private getResponse: GetEvaluatorResponse = DEFAULT_GET_EVALUATOR_RESPONSE;
  private deleteResponse: DeleteEvaluatorResponse = DEFAULT_DELETE_EVALUATOR_RESPONSE;
  private startRecommendationResponse: StartRecommendationResponse =
    DEFAULT_START_RECOMMENDATION_RESPONSE;
  private getRecommendationResponse: GetRecommendationResponse =
    DEFAULT_GET_RECOMMENDATION_RESPONSE;
  private recommendationListResponses = new Map<string | undefined, ListRecommendationsResponse>();
  private deleteRecommendationResponse: DeleteRecommendationResponse =
    DEFAULT_DELETE_RECOMMENDATION_RESPONSE;
  // Online-eval responses, keyed the same way: listOnlineEvaluationConfigs pages
  // by nextToken, the rest are single canned values.
  private onlineEvalListResponses = new Map<
    string | undefined,
    ListOnlineEvaluationConfigsResponse
  >();
  private onlineEvalCreateResponse: CreateOnlineEvaluationConfigResponse =
    DEFAULT_CREATE_ONLINE_EVAL_RESPONSE;
  private onlineEvalUpdateResponse: UpdateOnlineEvaluationConfigResponse =
    DEFAULT_UPDATE_ONLINE_EVAL_RESPONSE;
  private onlineEvalGetResponse: GetOnlineEvaluationConfigResponse =
    DEFAULT_GET_ONLINE_EVAL_RESPONSE;
  private onlineEvalDeleteResponse: DeleteOnlineEvaluationConfigResponse =
    DEFAULT_DELETE_ONLINE_EVAL_RESPONSE;
  private createConfigBundleResponse: CreateConfigurationBundleResponse =
    DEFAULT_CREATE_CONFIG_BUNDLE_RESPONSE;
  private getConfigBundleResponse: GetConfigurationBundleResponse =
    DEFAULT_GET_CONFIG_BUNDLE_RESPONSE;
  private getConfigBundleVersionResponse: GetConfigurationBundleVersionResponse =
    DEFAULT_GET_CONFIG_BUNDLE_VERSION_RESPONSE;
  private configBundleListResponses = new Map<
    string | undefined,
    ListConfigurationBundlesResponse
  >();
  private updateConfigBundleResponse: UpdateConfigurationBundleResponse =
    DEFAULT_UPDATE_CONFIG_BUNDLE_RESPONSE;
  private deleteConfigBundleResponse: DeleteConfigurationBundleResponse =
    DEFAULT_DELETE_CONFIG_BUNDLE_RESPONSE;
  private configBundleVersionListResponses = new Map<
    string | undefined,
    ListConfigurationBundleVersionsResponse
  >();
  private createDatasetResponse: CreateDatasetResponse = DEFAULT_CREATE_DATASET_RESPONSE;
  private getDatasetResponse: GetDatasetResponse = DEFAULT_GET_DATASET_RESPONSE;
  private datasetListResponses = new Map<string | undefined, ListDatasetsResponse>();
  private deleteDatasetResponse: DeleteDatasetResponse = DEFAULT_DELETE_DATASET_RESPONSE;
  private publishDatasetResponse: CreateDatasetVersionResponse = DEFAULT_PUBLISH_DATASET_RESPONSE;
  private updateDatasetResult: DatasetUpdateResult = DEFAULT_UPDATE_DATASET_RESULT;
  // Batch-evaluation responses: get returns a canned job, list pages by
  // nextToken, and the CloudWatch results are a canned array. batchEvalResultsError
  // simulates a CloudWatch read failure surfaced as `resultsError`.
  private batchEvalGetResponse: GetBatchEvaluationResponse = DEFAULT_GET_BATCH_EVAL_RESPONSE;
  private batchEvalListResponses = new Map<string | undefined, ListBatchEvaluationsResponse>();
  private batchInsightsListResponses = new Map<string | undefined, ListBatchEvaluationsResponse>();
  private abTestGetResponse: GetABTestResponse = DEFAULT_GET_ABTEST_RESPONSE;
  private abTestListResponses = new Map<string | undefined, ListABTestsResponse>();
  private abTestUpdateResponse: UpdateABTestResponse = DEFAULT_UPDATE_ABTEST_RESPONSE;
  private abTestDeleteResponse: DeleteABTestResponse = DEFAULT_DELETE_ABTEST_RESPONSE;
  private abTestCreateResponse: CreateABTestResponse = DEFAULT_CREATE_ABTEST_RESPONSE;
  private batchEvalResults: BatchEvaluationResultEntry[] = [];
  private batchEvalResultsError?: unknown;
  private startBatchEvalResponse: StartBatchEvaluationResponse = DEFAULT_START_BATCH_EVAL_RESPONSE;
  private getTracesResponse: SessionTrace[] = [];
  private evaluateResponse: EvaluateResult = {
    sessionsRequested: 0,
    sessionsEvaluated: 0,
    results: [],
  };
  private invokeDatasetResponse: InvokeDatasetResult = {
    sessions: [],
    invoked: 0,
    failed: 0,
    failures: [],
  };
  private error?: Error;

  // setListResponse sets what listEvaluators resolves to (when not erroring).
  // Pass `forNextToken` to serve a later page: the response is returned when
  // listEvaluators is called with that nextToken.
  setListResponse(response: ListEvaluatorsResponse, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
    return this;
  }

  // setCreateResponse sets what createEvaluator resolves to (when not erroring).
  setCreateResponse(response: CreateEvaluatorResponse): this {
    this.createResponse = response;
    return this;
  }

  // setUpdateResponse sets what both update*Evaluator methods resolve to (when
  // not erroring).
  setUpdateResponse(response: UpdateEvaluatorResponse): this {
    this.updateResponse = response;
    return this;
  }

  // setGetResponse sets what getEvaluator resolves to (when not erroring).
  setGetResponse(response: GetEvaluatorResponse): this {
    this.getResponse = response;
    return this;
  }

  // setDeleteResponse sets what deleteEvaluator resolves to (when not erroring).
  setDeleteResponse(response: DeleteEvaluatorResponse): this {
    this.deleteResponse = response;
    return this;
  }

  setStartRecommendationResponse(response: StartRecommendationResponse): this {
    this.startRecommendationResponse = response;
    return this;
  }

  setGetRecommendationResponse(response: GetRecommendationResponse): this {
    this.getRecommendationResponse = response;
    return this;
  }

  setListRecommendationsResponse(
    response: ListRecommendationsResponse,
    forNextToken?: string,
  ): this {
    this.recommendationListResponses.set(forNextToken, response);
    return this;
  }

  setDeleteRecommendationResponse(response: DeleteRecommendationResponse): this {
    this.deleteRecommendationResponse = response;
    return this;
  }

  // setOnlineEvalListResponse sets what listOnlineEvaluationConfigs resolves to
  // (when not erroring). Pass `forNextToken` to serve a later page.
  setOnlineEvalListResponse(
    response: ListOnlineEvaluationConfigsResponse,
    forNextToken?: string,
  ): this {
    this.onlineEvalListResponses.set(forNextToken, response);
    return this;
  }

  // setOnlineEvalCreateResponse sets what createOnlineEvaluationConfig resolves
  // to (when not erroring).
  setOnlineEvalCreateResponse(response: CreateOnlineEvaluationConfigResponse): this {
    this.onlineEvalCreateResponse = response;
    return this;
  }

  // setOnlineEvalUpdateResponse sets what updateOnlineEvaluationConfig and
  // setOnlineEvaluationExecutionStatus resolve to (when not erroring).
  setOnlineEvalUpdateResponse(response: UpdateOnlineEvaluationConfigResponse): this {
    this.onlineEvalUpdateResponse = response;
    return this;
  }

  // setOnlineEvalGetResponse sets what getOnlineEvaluationConfig resolves to
  // (when not erroring).
  setOnlineEvalGetResponse(response: GetOnlineEvaluationConfigResponse): this {
    this.onlineEvalGetResponse = response;
    return this;
  }

  // setOnlineEvalDeleteResponse sets what deleteOnlineEvaluationConfig resolves
  // to (when not erroring).
  setOnlineEvalDeleteResponse(response: DeleteOnlineEvaluationConfigResponse): this {
    this.onlineEvalDeleteResponse = response;
    return this;
  }

  setCreateConfigurationBundleResponse(response: CreateConfigurationBundleResponse): this {
    this.createConfigBundleResponse = response;
    return this;
  }

  setGetConfigurationBundleResponse(response: GetConfigurationBundleResponse): this {
    this.getConfigBundleResponse = response;
    return this;
  }

  setGetConfigurationBundleVersionResponse(response: GetConfigurationBundleVersionResponse): this {
    this.getConfigBundleVersionResponse = response;
    return this;
  }

  setListConfigurationBundlesResponse(
    response: ListConfigurationBundlesResponse,
    forNextToken?: string,
  ): this {
    this.configBundleListResponses.set(forNextToken, response);
    return this;
  }

  setUpdateConfigurationBundleResponse(response: UpdateConfigurationBundleResponse): this {
    this.updateConfigBundleResponse = response;
    return this;
  }

  setDeleteConfigurationBundleResponse(response: DeleteConfigurationBundleResponse): this {
    this.deleteConfigBundleResponse = response;
    return this;
  }

  setListConfigurationBundleVersionsResponse(
    response: ListConfigurationBundleVersionsResponse,
    forNextToken?: string,
  ): this {
    this.configBundleVersionListResponses.set(forNextToken, response);
    return this;
  }

  // setCreateDatasetResponse sets what createDataset resolves to (when not
  // erroring).
  setCreateDatasetResponse(response: CreateDatasetResponse): this {
    this.createDatasetResponse = response;
    return this;
  }

  // setGetDatasetResponse sets what getDataset and downloadDataset resolve to
  // (when not erroring).
  setGetDatasetResponse(response: GetDatasetResponse): this {
    this.getDatasetResponse = response;
    return this;
  }

  // setListDatasetsResponse sets what listDatasets resolves to (when not
  // erroring). Pass `forNextToken` to serve a later page.
  setListDatasetsResponse(response: ListDatasetsResponse, forNextToken?: string): this {
    this.datasetListResponses.set(forNextToken, response);
    return this;
  }

  // setDeleteDatasetResponse sets what deleteDataset resolves to (when not
  // erroring).
  setDeleteDatasetResponse(response: DeleteDatasetResponse): this {
    this.deleteDatasetResponse = response;
    return this;
  }

  // setPublishDatasetResponse sets what publishDataset resolves to (when not
  // erroring).
  setPublishDatasetResponse(response: CreateDatasetVersionResponse): this {
    this.publishDatasetResponse = response;
    return this;
  }

  // setBatchEvalGetResponse sets what getBatchEvaluation resolves to (when not
  // erroring).
  setBatchEvalGetResponse(response: GetBatchEvaluationResponse): this {
    this.batchEvalGetResponse = response;
    return this;
  }

  // setBatchEvalListResponse sets what listBatchEvaluations resolves to (when
  // not erroring). Pass `forNextToken` to serve a later page.
  setBatchEvalListResponse(response: ListBatchEvaluationsResponse, forNextToken?: string): this {
    this.batchEvalListResponses.set(forNextToken, response);
    return this;
  }

  // setBatchInsightsListResponse sets what listBatchInsights resolves to (when
  // not erroring). Pass `forNextToken` to serve a later logical Insights page.
  setBatchInsightsListResponse(
    response: ListBatchEvaluationsResponse,
    forNextToken?: string,
  ): this {
    this.batchInsightsListResponses.set(forNextToken, response);
    return this;
  }

  // setBatchEvalResults sets the per-session results getBatchEvaluation merges in
  // (when results are requested, the job is terminal, and it has a CloudWatch
  // output config).
  setBatchEvalResults(results: BatchEvaluationResultEntry[]): this {
    this.batchEvalResults = results;
    return this;
  }

  // setBatchEvalResultsError makes getBatchEvaluation return `resultsError`
  // instead of merged results, simulating a CloudWatch read failure. The job
  // metadata is still returned.
  setBatchEvalResultsError(error: unknown): this {
    this.batchEvalResultsError = error;
    return this;
  }

  setAbTestGetResponse(response: GetABTestResponse): this {
    this.abTestGetResponse = response;
    return this;
  }

  setAbTestListResponse(response: ListABTestsResponse, forNextToken?: string): this {
    this.abTestListResponses.set(forNextToken, response);
    return this;
  }

  setAbTestUpdateResponse(response: UpdateABTestResponse): this {
    this.abTestUpdateResponse = response;
    return this;
  }

  setAbTestDeleteResponse(response: DeleteABTestResponse): this {
    this.abTestDeleteResponse = response;
    return this;
  }

  setAbTestCreateResponse(response: CreateABTestResponse): this {
    this.abTestCreateResponse = response;
    return this;
  }

  // setUpdateDatasetResult sets what updateDatasetExamples resolves to (when not
  // erroring).
  setUpdateDatasetResult(result: DatasetUpdateResult): this {
    this.updateDatasetResult = result;
    return this;
  }

  // setError makes every subsequent call reject with `error`. Pass undefined to
  // clear it.
  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async createEvaluator(
    request: CreateEvaluatorRequest,
    options: CoreOptions,
  ): Promise<CreateEvaluatorResponse> {
    this.calls.push({ method: "createEvaluator", args: [request, options] });
    if (this.error) throw this.error;
    return this.createResponse;
  }

  async updateLlmAsAJudgeEvaluator(
    id: string,
    update: LlmAsAJudgeUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse> {
    this.calls.push({ method: "updateLlmAsAJudgeEvaluator", args: [id, update, options] });
    if (this.error) throw this.error;
    return this.updateResponse;
  }

  async updateCodeBasedEvaluator(
    id: string,
    update: CodeBasedUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse> {
    this.calls.push({ method: "updateCodeBasedEvaluator", args: [id, update, options] });
    if (this.error) throw this.error;
    return this.updateResponse;
  }

  async getEvaluator(id: string, options: CoreOptions): Promise<GetEvaluatorResponse> {
    this.calls.push({ method: "getEvaluator", args: [id, options] });
    if (this.error) throw this.error;
    return this.getResponse;
  }

  async listEvaluators(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListEvaluatorsResponse> {
    this.calls.push({ method: "listEvaluators", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.listResponses.get(nextToken) ??
      this.listResponses.get(undefined) ??
      DEFAULT_LIST_EVALUATORS_RESPONSE
    );
  }

  async deleteEvaluator(id: string, options: CoreOptions): Promise<DeleteEvaluatorResponse> {
    this.calls.push({ method: "deleteEvaluator", args: [id, options] });
    if (this.error) throw this.error;
    return this.deleteResponse;
  }

  async startRecommendation(
    input: StartRecommendationInput,
    options: CoreOptions,
  ): Promise<StartRecommendationResponse> {
    this.calls.push({ method: "startRecommendation", args: [input, options] });
    if (this.error) throw this.error;
    return this.startRecommendationResponse;
  }

  async getRecommendation(id: string, options: CoreOptions): Promise<GetRecommendationResponse> {
    this.calls.push({ method: "getRecommendation", args: [id, options] });
    if (this.error) throw this.error;
    return this.getRecommendationResponse;
  }

  async listRecommendations(
    nextToken: string | undefined,
    maxResults: number | undefined,
    statusFilter: RecommendationStatus | undefined,
    options: CoreOptions,
  ): Promise<ListRecommendationsResponse> {
    this.calls.push({
      method: "listRecommendations",
      args: [nextToken, maxResults, statusFilter, options],
    });
    if (this.error) throw this.error;
    return (
      this.recommendationListResponses.get(nextToken) ??
      this.recommendationListResponses.get(undefined) ??
      DEFAULT_LIST_RECOMMENDATIONS_RESPONSE
    );
  }

  async deleteRecommendation(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteRecommendationResponse> {
    this.calls.push({ method: "deleteRecommendation", args: [id, options] });
    if (this.error) throw this.error;
    return this.deleteRecommendationResponse;
  }

  async getBatchEvaluation(
    id: string,
    options: CoreOptions,
    opts: { includeResults?: boolean } = {},
  ): Promise<GetBatchEvaluationResult> {
    this.calls.push({ method: "getBatchEvaluation", args: [id, options, opts] });
    if (this.error) throw this.error;

    const detail: BatchEvaluationDetail = { ...this.batchEvalGetResponse };
    const includeResults = opts.includeResults ?? true;
    const cw = detail.outputConfig?.cloudWatchConfig;
    // Mirror the real client's gate: only merge results when requested, terminal,
    // and a CloudWatch output config exists.
    if (!includeResults || !isTerminalStatus(detail.status) || !cw?.logGroupName) {
      return { detail };
    }
    if (this.batchEvalResultsError !== undefined) {
      return { detail, resultsError: this.batchEvalResultsError };
    }
    detail.results = this.batchEvalResults;
    return { detail };
  }

  async getBatchInsights(id: string, options: CoreOptions): Promise<BatchEvaluationDetail> {
    this.calls.push({ method: "getBatchInsights", args: [id, options] });
    if (this.error) throw this.error;

    const detail: BatchEvaluationDetail = { ...this.batchEvalGetResponse };
    if (!detail.insights?.length) {
      throw new InputValidationError(`batch evaluation "${id}" is not a batch insights run`);
    }
    return detail;
  }

  async listBatchEvaluations(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListBatchEvaluationsResponse> {
    this.calls.push({ method: "listBatchEvaluations", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.batchEvalListResponses.get(nextToken) ??
      this.batchEvalListResponses.get(undefined) ??
      DEFAULT_LIST_BATCH_EVALS_RESPONSE
    );
  }

  async listBatchInsights(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListBatchEvaluationsResponse> {
    this.calls.push({ method: "listBatchInsights", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    const response =
      this.batchInsightsListResponses.get(nextToken) ??
      this.batchInsightsListResponses.get(undefined) ??
      DEFAULT_LIST_BATCH_EVALS_RESPONSE;
    return { ...response, batchEvaluations: response.batchEvaluations ?? [] };
  }

  async getABTest(id: string, options: CoreOptions): Promise<GetABTestResponse> {
    this.calls.push({ method: "getABTest", args: [id, options] });
    if (this.error) throw this.error;
    return this.abTestGetResponse;
  }

  async listABTests(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListABTestsResponse> {
    this.calls.push({ method: "listABTests", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.abTestListResponses.get(nextToken) ??
      this.abTestListResponses.get(undefined) ??
      DEFAULT_LIST_ABTESTS_RESPONSE
    );
  }

  async setABTestExecutionStatus(
    id: string,
    executionStatus: ABTestExecutionStatus,
    options: CoreOptions,
  ): Promise<UpdateABTestResponse> {
    this.calls.push({ method: "setABTestExecutionStatus", args: [id, executionStatus, options] });
    if (this.error) throw this.error;
    return this.abTestUpdateResponse;
  }

  async deleteABTest(id: string, options: CoreOptions): Promise<DeleteABTestResponse> {
    this.calls.push({ method: "deleteABTest", args: [id, options] });
    if (this.error) throw this.error;
    return this.abTestDeleteResponse;
  }

  async createConfigBasedABTest(
    input: CreateConfigBasedABTestInput,
    options: CoreOptions,
  ): Promise<CreateABTestResponse> {
    this.calls.push({ method: "createConfigBasedABTest", args: [input, options] });
    if (this.error) throw this.error;
    return this.abTestCreateResponse;
  }

  async createTargetBasedABTest(
    input: CreateTargetBasedABTestInput,
    options: CoreOptions,
  ): Promise<CreateABTestResponse> {
    this.calls.push({ method: "createTargetBasedABTest", args: [input, options] });
    if (this.error) throw this.error;
    return this.abTestCreateResponse;
  }

  async startBatchEvaluation(
    input: StartBatchEvaluationInput,
    options: CoreOptions,
  ): Promise<StartBatchEvaluationResponse> {
    this.calls.push({ method: "startBatchEvaluation", args: [input, options] });
    if (this.error) throw this.error;
    return this.startBatchEvalResponse;
  }

  async startBatchInsights(
    input: StartBatchInsightsInput,
    options: CoreOptions,
  ): Promise<StartBatchEvaluationResponse> {
    this.calls.push({ method: "startBatchInsights", args: [input, options] });
    if (this.error) throw this.error;
    return this.startBatchEvalResponse;
  }

  // setGetTracesResponse sets what getTracesForAgent resolves to (when not
  // erroring).
  setGetTracesResponse(traces: SessionTrace[]): this {
    this.getTracesResponse = traces;
    return this;
  }

  // setEvaluateResponse sets what evaluate resolves to (when not erroring).
  setEvaluateResponse(response: EvaluateResult): this {
    this.evaluateResponse = response;
    return this;
  }

  async getTracesForAgent(input: GetTracesInput, options: CoreOptions): Promise<SessionTrace[]> {
    this.calls.push({ method: "getTracesForAgent", args: [input, options] });
    if (this.error) throw this.error;
    return this.getTracesResponse;
  }

  async evaluate(input: EvaluateInput, options: CoreOptions): Promise<EvaluateResult> {
    this.calls.push({ method: "evaluate", args: [input, options] });
    if (this.error) throw this.error;
    return this.evaluateResponse;
  }

  // setInvokeDatasetResponse sets what invokeDataset resolves to (when not erroring).
  setInvokeDatasetResponse(response: InvokeDatasetResult): this {
    this.invokeDatasetResponse = response;
    return this;
  }

  async invokeDataset(
    input: InvokeDatasetInput,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InvokeDatasetResult> {
    this.calls.push({ method: "invokeDataset", args: [input, options, signal] });
    if (this.error) throw this.error;
    return this.invokeDatasetResponse;
  }

  async createOnlineEvaluationConfig(
    input: CreateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<CreateOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "createOnlineEvaluationConfig", args: [input, options] });
    if (this.error) throw this.error;
    return this.onlineEvalCreateResponse;
  }

  async updateOnlineEvaluationConfig(
    id: string,
    update: UpdateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<{ response: UpdateOnlineEvaluationConfigResponse }> {
    this.calls.push({ method: "updateOnlineEvaluationConfig", args: [id, update, options] });
    if (this.error) throw this.error;
    return { response: this.onlineEvalUpdateResponse };
  }

  async getOnlineEvaluationConfig(
    id: string,
    options: CoreOptions,
  ): Promise<GetOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "getOnlineEvaluationConfig", args: [id, options] });
    if (this.error) throw this.error;
    return this.onlineEvalGetResponse;
  }

  async listOnlineEvaluationConfigs(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOnlineEvaluationConfigsResponse> {
    this.calls.push({
      method: "listOnlineEvaluationConfigs",
      args: [nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return this.onlineEvalListResponses.get(nextToken) ?? { onlineEvaluationConfigs: [] };
  }

  async setOnlineEvaluationExecutionStatus(
    id: string,
    executionStatus: "ENABLED" | "DISABLED",
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse> {
    this.calls.push({
      method: "setOnlineEvaluationExecutionStatus",
      args: [id, executionStatus, options],
    });
    if (this.error) throw this.error;
    return this.onlineEvalUpdateResponse;
  }

  async deleteOnlineEvaluationConfig(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "deleteOnlineEvaluationConfig", args: [id, options] });
    if (this.error) throw this.error;
    return this.onlineEvalDeleteResponse;
  }

  async createOnlineInsight(
    input: CreateOnlineInsightInput,
    options: CoreOptions,
  ): Promise<CreateOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "createOnlineInsight", args: [input, options] });
    if (this.error) throw this.error;
    return this.onlineEvalCreateResponse;
  }

  async updateOnlineInsight(
    id: string,
    update: UpdateOnlineInsightInput,
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "updateOnlineInsight", args: [id, update, options] });
    if (this.error) throw this.error;
    return this.onlineEvalUpdateResponse;
  }

  async getOnlineInsight(
    id: string,
    options: CoreOptions,
  ): Promise<GetOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "getOnlineInsight", args: [id, options] });
    if (this.error) throw this.error;
    return this.onlineEvalGetResponse;
  }

  async listOnlineInsights(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOnlineEvaluationConfigsResponse> {
    this.calls.push({ method: "listOnlineInsights", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return this.onlineEvalListResponses.get(nextToken) ?? { onlineEvaluationConfigs: [] };
  }

  async setOnlineInsightExecutionStatus(
    id: string,
    executionStatus: "ENABLED" | "DISABLED",
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse> {
    this.calls.push({
      method: "setOnlineInsightExecutionStatus",
      args: [id, executionStatus, options],
    });
    if (this.error) throw this.error;
    return this.onlineEvalUpdateResponse;
  }

  async deleteOnlineInsight(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteOnlineEvaluationConfigResponse> {
    this.calls.push({ method: "deleteOnlineInsight", args: [id, options] });
    if (this.error) throw this.error;
    return this.onlineEvalDeleteResponse;
  }

  async createConfigurationBundle(
    input: CreateConfigurationBundleInput,
    options: CoreOptions,
  ): Promise<CreateConfigurationBundleResponse> {
    this.calls.push({ method: "createConfigurationBundle", args: [input, options] });
    if (this.error) throw this.error;
    return this.createConfigBundleResponse;
  }

  async getConfigurationBundle(
    id: string,
    version: string | undefined,
    branchName: string,
    options: CoreOptions,
  ): Promise<GetConfigurationBundleResponse | GetConfigurationBundleVersionResponse> {
    this.calls.push({ method: "getConfigurationBundle", args: [id, version, branchName, options] });
    if (this.error) throw this.error;
    return version === undefined
      ? this.getConfigBundleResponse
      : this.getConfigBundleVersionResponse;
  }

  async listConfigurationBundles(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListConfigurationBundlesResponse> {
    this.calls.push({ method: "listConfigurationBundles", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return (
      this.configBundleListResponses.get(nextToken) ??
      this.configBundleListResponses.get(undefined) ??
      DEFAULT_LIST_CONFIG_BUNDLES_RESPONSE
    );
  }

  async updateConfigurationBundle(
    id: string,
    update: UpdateConfigurationBundleInput,
    options: CoreOptions,
  ): Promise<UpdateConfigurationBundleResponse> {
    this.calls.push({ method: "updateConfigurationBundle", args: [id, update, options] });
    if (this.error) throw this.error;
    return this.updateConfigBundleResponse;
  }

  async deleteConfigurationBundle(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteConfigurationBundleResponse> {
    this.calls.push({ method: "deleteConfigurationBundle", args: [id, options] });
    if (this.error) throw this.error;
    return this.deleteConfigBundleResponse;
  }

  async listConfigurationBundleVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListConfigurationBundleVersionsResponse> {
    this.calls.push({
      method: "listConfigurationBundleVersions",
      args: [id, nextToken, maxResults, options],
    });
    if (this.error) throw this.error;
    return (
      this.configBundleVersionListResponses.get(nextToken) ??
      this.configBundleVersionListResponses.get(undefined) ??
      DEFAULT_LIST_CONFIG_BUNDLE_VERSIONS_RESPONSE
    );
  }

  async createDataset(
    input: CreateDatasetInput,
    options: CoreOptions,
  ): Promise<CreateDatasetResponse> {
    this.calls.push({ method: "createDataset", args: [input, options] });
    if (this.error) throw this.error;
    return this.createDatasetResponse;
  }

  async getDataset(
    id: string,
    version: string | undefined,
    options: CoreOptions,
  ): Promise<GetDatasetResponse> {
    this.calls.push({ method: "getDataset", args: [id, version, options] });
    if (this.error) throw this.error;
    return this.getDatasetResponse;
  }

  async downloadDataset(
    id: string,
    version: string | undefined,
    filePath: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetDatasetResponse> {
    this.calls.push({ method: "downloadDataset", args: [id, version, filePath, options, signal] });
    if (this.error) throw this.error;
    return this.getDatasetResponse;
  }

  async listDatasets(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListDatasetsResponse> {
    this.calls.push({ method: "listDatasets", args: [nextToken, maxResults, options] });
    if (this.error) throw this.error;
    return this.datasetListResponses.get(nextToken) ?? DEFAULT_LIST_DATASETS_RESPONSE;
  }

  async deleteDataset(
    id: string,
    version: string | undefined,
    options: CoreOptions,
  ): Promise<DeleteDatasetResponse> {
    this.calls.push({ method: "deleteDataset", args: [id, version, options] });
    if (this.error) throw this.error;
    return this.deleteDatasetResponse;
  }

  async publishDataset(id: string, options: CoreOptions): Promise<CreateDatasetVersionResponse> {
    this.calls.push({ method: "publishDataset", args: [id, options] });
    if (this.error) throw this.error;
    return this.publishDatasetResponse;
  }

  async updateDatasetExamples(
    id: string,
    filePath: string,
    options: CoreOptions,
    signal?: AbortSignal,
    onProgress?: (event: DatasetUpdateProgressEvent) => void,
  ): Promise<DatasetUpdateResult> {
    this.calls.push({
      method: "updateDatasetExamples",
      args: [id, filePath, options, signal, onProgress],
    });
    if (this.error) throw this.error;
    return this.updateDatasetResult;
  }
}

// TestObservabilityClient is a controllable CoreObservabilityClient: seed
// `logEvents` / `resolveDeployedRuntimeResponse`, or set `error` to force the
// next call to throw. Every call is recorded on `calls`.
export class TestObservabilityClient implements CoreObservabilityClient {
  calls: { method: string; args: unknown[] }[] = [];
  error: Error | undefined;

  resolveDeployedRuntimeResponse: DeployedRuntime = {
    runtimeId: "project_runtime-0000000000",
    region: "us-west-2",
    stackName: "AgentCore-project-default",
    targetName: "default",
  };
  logEvents: CloudWatchLogEvent[] = [];
  queryRows: InsightsQueryRow[] = [];

  async resolveDeployedRuntime(project: Project, targetName: string): Promise<DeployedRuntime> {
    this.calls.push({ method: "resolveDeployedRuntime", args: [project, targetName] });
    if (this.error) throw this.error;
    return this.resolveDeployedRuntimeResponse;
  }

  async *searchLogs(
    source: LogSource,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    this.calls.push({ method: "searchLogs", args: [source, query, options, signal] });
    if (this.error) throw this.error;
    yield* this.logEvents;
  }

  async *tailLogs(
    source: LogSource,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    this.calls.push({ method: "tailLogs", args: [source, query, options, signal] });
    if (this.error) throw this.error;
    yield* this.logEvents;
  }

  async queryLogs(
    source: LogSource,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]> {
    this.calls.push({ method: "queryLogs", args: [source, query, options, signal] });
    if (this.error) throw this.error;
    return this.queryRows;
  }

  traceSummaries: TraceSummary[] = [];
  traceRecords: TraceRecord[] = [];

  async listTraces(
    source: LogSource,
    query: ListTracesQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceSummary[]> {
    this.calls.push({ method: "listTraces", args: [source, query, options, signal] });
    if (this.error) throw this.error;
    return this.traceSummaries;
  }

  async getTrace(
    source: LogSource,
    query: GetTraceQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceRecord[]> {
    this.calls.push({ method: "getTrace", args: [source, query, options, signal] });
    if (this.error) throw this.error;
    return this.traceRecords;
  }
}

export class TestPolicyClient implements CorePolicyClient {
  result: PolicyGenerationResult = {
    policyGenerationId: "gen-1",
    policyEngineId: "pe-1",
    gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/gw-1",
    policies: [
      { statement: "forbid (principal, action, resource is AgentCore::Gateway);", findings: [] },
    ],
  };
  error: Error | undefined;
  // hang keeps the generator waiting after its first step until the signal aborts.
  hang = false;
  readonly calls: GeneratePolicyInput[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  async *generatePolicy(
    input: GeneratePolicyInput,
    _options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<ProgressEvent, PolicyGenerationResult> {
    this.calls.push(input);
    this.signals.push(signal);
    yield { type: "step", message: "Resolving gateway" };
    if (this.hang) {
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
    if (this.error) throw this.error;
    return this.result;
  }
}

// TestCoreClient implements the Core contract with fully controllable sub-clients.
export class TestCoreClient implements Core {
  readonly harness = new TestHarnessClient();
  readonly identity = new TestIdentityClient();
  readonly memory = new TestMemoryClient();
  readonly runtime = new TestRuntimeClient();
  readonly gateway = new TestGatewayClient();
  readonly eval = new TestEvalClient();
  readonly observability = new TestObservabilityClient();
  readonly policy = new TestPolicyClient();
  fetch: CoreFetch = (async () => {
    throw new Error("TestCoreClient.fetch is not configured; set it in the test that needs it");
  }) as unknown as CoreFetch;
  readonly projectManager: ProjectManager;

  // Commands the project manager would have run (npm install, git init, ...),
  // recorded instead of spawned so tests stay fast and hermetic.
  readonly projectCommands: { command: string[]; cwd: string }[] = [];

  // Seed with `agentId/agentAliasId` keys to make Bedrock Agent imports
  // resolvable; unseeded ids reject like the service would.
  readonly bedrockAgentImportPlans: Record<string, BedrockAgentImportPlan> = {};
  readonly importedBedrockAgents: BedrockAgentImportRequest[] = [];
  readonly bedrockAgentImporter: CoreBedrockAgentImporter = {
    import: async (input) => {
      if (!(BEDROCK_AGENT_IMPORT_REGIONS as readonly string[]).includes(input.region)) {
        throw new InputValidationError(
          `'${input.region}' is not a supported Bedrock Agent region for import`,
        );
      }
      this.importedBedrockAgents.push(input);
      const plan = this.bedrockAgentImportPlans[`${input.agentId}/${input.agentAliasId}`];
      if (plan) return plan;
      throw new InputValidationError(
        `no Bedrock Agent with id '${input.agentId}' exists in ${input.region}; ` +
          `check --agent-id and --region`,
      );
    },
  };

  constructor(options?: TestCoreClientOptions) {
    this.projectManager = new FsProjectManager({
      logger: options?.logger ?? createSilentLogger(),
      createCloudFormationClient: options?.createCloudFormationClient,
      identity: this.identity,
      json: options?.json,
      backends: options?.backends,
      runner: async (command, { cwd }) => {
        this.projectCommands.push({ command, cwd });
      },
      checkTool: async () => {}, // CI hosts don't have uv installed
      // Deploy synthesizes the default target through STS; stub the lookup so
      // tests stay hermetic.
      resolveAccount: options?.resolveAccount ?? (async () => "111122223333"),
    });
  }
}
