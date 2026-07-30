import type {
  CreateApiKeyCredentialProviderResponse,
  CreateHarnessEndpointRequest,
  CreateHarnessEndpointResponse,
  CreateHarnessResponse,
  DeleteApiKeyCredentialProviderResponse,
  DeleteHarnessEndpointRequest,
  DeleteHarnessEndpointResponse,
  DeleteHarnessRequest,
  DeleteHarnessResponse,
  GetGatewayResponse,
  GetGatewayRuleResponse,
  GetGatewayTargetResponse,
  GetApiKeyCredentialProviderResponse,
  GetHarnessResponse,
  GetHarnessEndpointResponse,
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  GetMemoryOutput,
  ListApiKeyCredentialProvidersResponse,
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
  CreateEvaluatorRequest,
  CreateEvaluatorResponse,
  DeleteEvaluatorResponse,
  GetEvaluatorResponse,
  ListEvaluatorsResponse,
  MemoryView,
  UpdateEvaluatorResponse,
  UpdateApiKeyCredentialProviderResponse,
  UpdateHarnessEndpointRequest,
  UpdateHarnessEndpointResponse,
  UpdateHarnessRequest,
  UpdateHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandResponse,
  InvokeAgentRuntimeCommandStreamOutput,
  InvokeHarnessRequest,
  InvokeHarnessResponse,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { Core } from "../handlers/types";
import type { CoreHarnessClient, CreateHarnessInput } from "../handlers/harness/types";
import type { CoreGatewayClient } from "../handlers/gateway/types";
import type {
  CoreIdentityClient,
  CreateApiKeyCredentialProviderInput,
  UpdateApiKeyCredentialProviderInput,
} from "../handlers/identity/types";
import type { CoreMemoryClient } from "../handlers/memory/types";
import type {
  CoreRuntimeClient,
  RuntimeInvokeRequest,
  RuntimeInvokeResponse,
} from "../handlers/runtime/types";
import type { CodeBasedUpdate, CoreEvalClient, LlmAsAJudgeUpdate } from "../handlers/eval/types";
import { abortable } from "../core/abortable";
import type { CoreOptions } from "../core/types";
import type { ProjectManager } from "../handlers/project/types";
import type { Logger } from "../logging";
import { createSilentLogger } from "./logging";
import { FsProjectManager } from "../core/project";

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
const DEFAULT_GET_MEMORY_RESPONSE = {} as GetMemoryOutput;
const DEFAULT_LIST_MEMORIES_RESPONSE: ListMemoriesOutput = { memories: [] };
const DEFAULT_GET_GATEWAY_RESPONSE = {} as GetGatewayResponse;
const DEFAULT_LIST_GATEWAYS_RESPONSE: ListGatewaysResponse = { items: [] };
const DEFAULT_GET_GATEWAY_TARGET_RESPONSE = {} as GetGatewayTargetResponse;
const DEFAULT_LIST_GATEWAY_TARGETS_RESPONSE: ListGatewayTargetsResponse = { items: [] };
const DEFAULT_GET_GATEWAY_RULE_RESPONSE = {} as GetGatewayRuleResponse;
const DEFAULT_LIST_GATEWAY_RULES_RESPONSE: ListGatewayRulesResponse = { gatewayRules: [] };
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

// events wraps canned events as a one-shot AsyncIterable.
async function* events<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const DEFAULT_RUNTIME_INVOKE_RESPONSE: RuntimeInvokeResponse = {
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
  private error?: Error;

  setGetResponse(response: GetMemoryOutput): this {
    this.getResponse = response;
    return this;
  }

  setListResponse(response: ListMemoriesOutput, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
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
}

export class TestGatewayClient implements CoreGatewayClient {
  readonly calls: RecordedCall[] = [];

  private getResponse: GetGatewayResponse = DEFAULT_GET_GATEWAY_RESPONSE;
  private listResponses = new Map<string | undefined, ListGatewaysResponse>();
  private getTargetResponse: GetGatewayTargetResponse = DEFAULT_GET_GATEWAY_TARGET_RESPONSE;
  private listTargetResponses = new Map<string | undefined, ListGatewayTargetsResponse>();
  private getRuleResponse: GetGatewayRuleResponse = DEFAULT_GET_GATEWAY_RULE_RESPONSE;
  private listRuleResponses = new Map<string | undefined, ListGatewayRulesResponse>();
  private error?: Error;

  setGetResponse(response: GetGatewayResponse): this {
    this.getResponse = response;
    return this;
  }

  setListResponse(response: ListGatewaysResponse, forNextToken?: string): this {
    this.listResponses.set(forNextToken, response);
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

  setGetRuleResponse(response: GetGatewayRuleResponse): this {
    this.getRuleResponse = response;
    return this;
  }

  setListRulesResponse(response: ListGatewayRulesResponse, forNextToken?: string): this {
    this.listRuleResponses.set(forNextToken, response);
    return this;
  }

  setError(error: Error | undefined): this {
    this.error = error;
    return this;
  }

  async getGateway(id: string, options: CoreOptions): Promise<GetGatewayResponse> {
    this.calls.push({ method: "getGateway", args: [id, options] });
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
}

type TestCoreClientOptions = {
  logger?: Logger;
};

class TestIdentityClient implements CoreIdentityClient {
  async createApiKeyCredentialProvider(
    _input: CreateApiKeyCredentialProviderInput,
    _options: CoreOptions,
  ): Promise<CreateApiKeyCredentialProviderResponse> {
    return DEFAULT_CREATE_API_KEY_RESPONSE;
  }

  async getApiKeyCredentialProvider(
    _name: string,
    _options: CoreOptions,
  ): Promise<GetApiKeyCredentialProviderResponse> {
    return DEFAULT_GET_API_KEY_RESPONSE;
  }

  async listApiKeyCredentialProviders(
    _nextToken: string | undefined,
    _maxResults: number | undefined,
    _options: CoreOptions,
  ): Promise<ListApiKeyCredentialProvidersResponse> {
    return DEFAULT_LIST_API_KEYS_RESPONSE;
  }

  async updateApiKeyCredentialProvider(
    _input: UpdateApiKeyCredentialProviderInput,
    _options: CoreOptions,
  ): Promise<UpdateApiKeyCredentialProviderResponse> {
    return DEFAULT_UPDATE_API_KEY_RESPONSE;
  }

  async deleteApiKeyCredentialProvider(
    _name: string,
    _options: CoreOptions,
  ): Promise<DeleteApiKeyCredentialProviderResponse> {
    return DEFAULT_DELETE_API_KEY_RESPONSE;
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
}

// TestCoreClient implements the Core contract with fully controllable sub-clients.
export class TestCoreClient implements Core {
  readonly harness = new TestHarnessClient();
  readonly identity = new TestIdentityClient();
  readonly memory = new TestMemoryClient();
  readonly runtime = new TestRuntimeClient();
  readonly gateway = new TestGatewayClient();
  readonly eval = new TestEvalClient();
  readonly projectManager: ProjectManager;

  // Commands the project manager would have run (npm install, git init, ...),
  // recorded instead of spawned so tests stay fast and hermetic.
  readonly projectCommands: { command: string[]; cwd: string }[] = [];

  constructor(options?: TestCoreClientOptions) {
    this.projectManager = new FsProjectManager({
      logger: options?.logger ?? createSilentLogger(),
      runner: async (command, { cwd }) => {
        this.projectCommands.push({ command, cwd });
      },
    });
  }
}
