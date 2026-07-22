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
  GetApiKeyCredentialProviderResponse,
  GetHarnessResponse,
  GetHarnessEndpointResponse,
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  ListApiKeyCredentialProvidersResponse,
  ListAgentRuntimeEndpointsResponse,
  ListAgentRuntimesResponse,
  ListAgentRuntimeVersionsResponse,
  ListHarnessesResponse,
  ListHarnessEndpointsResponse,
  ListHarnessVersionsResponse,
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
import type { CoreIdentityClient } from "../handlers/identity/types";
import type { CoreRuntimeClient } from "../handlers/runtime/types";
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
const DEFAULT_GET_RUNTIME_RESPONSE = {} as GetAgentRuntimeResponse;
const DEFAULT_GET_RUNTIME_ENDPOINT_RESPONSE = {} as GetAgentRuntimeEndpointResponse;
const DEFAULT_LIST_RUNTIMES_RESPONSE: ListAgentRuntimesResponse = { agentRuntimes: [] };
const DEFAULT_LIST_RUNTIME_VERSIONS_RESPONSE: ListAgentRuntimeVersionsResponse = {
  agentRuntimes: [],
};
const DEFAULT_LIST_RUNTIME_ENDPOINTS_RESPONSE: ListAgentRuntimeEndpointsResponse = {
  runtimeEndpoints: [],
};

// abortError mirrors the error the SDK's abort handling rejects with.
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

// abortable wraps a stream so iteration rejects with an AbortError as soon as
// `signal` aborts, mirroring how the SDK cuts an event stream off mid-read.
// Each next() races against the abortion; the pre-attached catch swallows the
// rejection when nothing is racing (e.g. abort after the stream already ended)
// so tests don't fail on unhandled-rejection noise.
async function* abortable<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  if (!signal) {
    yield* source;
    return;
  }
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  aborted.catch(() => {});

  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    const result = await Promise.race([iterator.next(), aborted]);
    if (result.done) return;
    yield result.value;
  }
}

// events wraps canned events as a one-shot AsyncIterable.
async function* events<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

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
    return { stream: abortable(stream, abortSignal) };
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
      stream: abortable(stream, abortSignal),
    };
  }
}

class TestRuntimeClient implements CoreRuntimeClient {
  async getRuntime(_id: string, _options: CoreOptions): Promise<GetAgentRuntimeResponse> {
    return DEFAULT_GET_RUNTIME_RESPONSE;
  }

  async getRuntimeVersion(
    _id: string,
    _version: string,
    _options: CoreOptions,
  ): Promise<GetAgentRuntimeResponse> {
    return DEFAULT_GET_RUNTIME_RESPONSE;
  }

  async getRuntimeEndpoint(
    _id: string,
    _qualifier: string,
    _options: CoreOptions,
  ): Promise<GetAgentRuntimeEndpointResponse> {
    return DEFAULT_GET_RUNTIME_ENDPOINT_RESPONSE;
  }

  async listRuntimes(
    _nextToken: string | undefined,
    _maxResults: number | undefined,
    _options: CoreOptions,
  ): Promise<ListAgentRuntimesResponse> {
    return DEFAULT_LIST_RUNTIMES_RESPONSE;
  }

  async listRuntimeVersions(
    _id: string,
    _nextToken: string | undefined,
    _maxResults: number | undefined,
    _options: CoreOptions,
  ): Promise<ListAgentRuntimeVersionsResponse> {
    return DEFAULT_LIST_RUNTIME_VERSIONS_RESPONSE;
  }

  async listRuntimeEndpoints(
    _id: string,
    _nextToken: string | undefined,
    _maxResults: number | undefined,
    _options: CoreOptions,
  ): Promise<ListAgentRuntimeEndpointsResponse> {
    return DEFAULT_LIST_RUNTIME_ENDPOINTS_RESPONSE;
  }
}
type TestCoreClientOptions = {
  logger?: Logger;
};

class TestIdentityClient implements CoreIdentityClient {
  async createApiKeyCredentialProvider(
    _name: string,
    _apiKey: string,
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
    _name: string,
    _apiKey: string,
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

// TestCoreClient implements the Core contract with fully controllable sub-clients.
export class TestCoreClient implements Core {
  readonly harness = new TestHarnessClient();
  readonly identity = new TestIdentityClient();
  readonly runtime = new TestRuntimeClient();
  readonly projectManager: ProjectManager;

  constructor(options?: TestCoreClientOptions) {
    this.projectManager = new FsProjectManager({ logger: options?.logger ?? createSilentLogger() });
  }
}
