/**
 * Typed client wrappers for Harness control plane and data plane operations.
 *
 * Control plane: CreateHarness, GetHarness, UpdateHarness, DeleteHarness, ListHarnesses
 * Data plane: InvokeHarness (streaming)
 * TODO InvokeAgentRuntimeCommand
 *
 * Built on AgentCoreApiClient (shared SigV4 HTTP client).
 * Migrate to @aws-sdk/client-bedrock-agentcore-control when Harness commands land in the SDK.
 */
import { AgentCoreApiClient, AgentCoreApiError, resolveEndpoint } from './api-client';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Shared Types (from Smithy service model)
// ============================================================================

export type HarnessStatus = 'CREATING' | 'READY' | 'UPDATING' | 'DELETING' | 'DELETED' | 'FAILED';

export interface BedrockModelConfig {
  modelId: string;
  apiFormat?: 'converse_stream' | 'responses' | 'chat_completions';
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface OpenAiModelConfig {
  modelId: string;
  apiKeyArn?: string;
  apiFormat?: 'responses' | 'chat_completions';
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface GeminiModelConfig {
  modelId: string;
  apiKeyArn?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
}

export interface HarnessModelConfiguration {
  bedrockModelConfig?: BedrockModelConfig;
  openAiModelConfig?: OpenAiModelConfig;
  geminiModelConfig?: GeminiModelConfig;
}

export type HarnessSystemPrompt = { text: string }[];

export interface HarnessTool {
  type: string;
  name: string;
  browserArn?: string;
  codeInterpreterArn?: string;
  config?: Record<string, unknown>;
}

export interface HarnessSkill {
  path: string;
}

export interface HarnessAgentCoreMemoryConfiguration {
  arn: string;
  actorId?: string;
  messagesCount?: number;
  retrievalConfig?: Record<string, { topK?: number; relevanceScore?: number; strategyId?: string }>;
}

export interface HarnessMemoryConfiguration {
  agentCoreMemoryConfiguration: HarnessAgentCoreMemoryConfiguration;
}

export interface HarnessTruncationConfiguration {
  strategy: string;
  config: { slidingWindow?: { messagesCount: number } };
}

export interface HarnessEnvironmentArtifact {
  containerConfiguration?: { containerUri: string };
}

export interface HarnessAgentCoreRuntimeEnvironment {
  agentRuntimeArn?: string;
  agentRuntimeId?: string;
  agentRuntimeName?: string;
  lifecycleConfiguration?: Record<string, unknown>;
  networkConfiguration?: Record<string, unknown>;
  filesystemConfigurations?: Record<string, unknown>[];
}

export interface HarnessEnvironmentProvider {
  agentCoreRuntimeEnvironment?: HarnessAgentCoreRuntimeEnvironment;
}

export interface Harness {
  harnessId: string;
  harnessName: string;
  arn: string;
  status: HarnessStatus;
  executionRoleArn: string;
  model?: HarnessModelConfiguration;
  systemPrompt?: HarnessSystemPrompt;
  tools?: HarnessTool[];
  skills?: HarnessSkill[];
  allowedTools?: string[];
  memory?: HarnessMemoryConfiguration;
  truncation?: HarnessTruncationConfiguration;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  environment?: HarnessEnvironmentProvider;
  environmentArtifact?: HarnessEnvironmentArtifact;
  environmentVariables?: Record<string, string>;
  authorizerConfiguration?: Record<string, unknown>;
  tags?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessSummary {
  harnessId: string;
  harnessName: string;
  arn: string;
  status: HarnessStatus;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// CreateHarness
// ============================================================================

export interface CreateHarnessOptions {
  region: string;
  harnessName: string;
  executionRoleArn: string;
  environment?: HarnessEnvironmentProvider;
  environmentArtifact?: HarnessEnvironmentArtifact;
  environmentVariables?: Record<string, string>;
  authorizerConfiguration?: Record<string, unknown>;
  model?: HarnessModelConfiguration;
  systemPrompt?: HarnessSystemPrompt;
  tools?: HarnessTool[];
  skills?: HarnessSkill[];
  allowedTools?: string[];
  memory?: HarnessMemoryConfiguration;
  truncation?: HarnessTruncationConfiguration;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  tags?: Record<string, string>;
}

export interface CreateHarnessResult {
  harness: Harness;
}

export async function createHarness(options: CreateHarnessOptions): Promise<CreateHarnessResult> {
  const { region, ...rest } = options;
  const client = new AgentCoreApiClient({ region, plane: 'control' });

  const body: Record<string, unknown> = {
    harnessName: rest.harnessName,
    clientToken: randomUUID(),
    executionRoleArn: rest.executionRoleArn,
  };

  if (rest.environment) body.environment = rest.environment;
  if (rest.environmentArtifact) body.environmentArtifact = rest.environmentArtifact;
  if (rest.environmentVariables) body.environmentVariables = rest.environmentVariables;
  if (rest.authorizerConfiguration) body.authorizerConfiguration = rest.authorizerConfiguration;
  if (rest.model) body.model = rest.model;
  if (rest.systemPrompt) body.systemPrompt = rest.systemPrompt;
  if (rest.tools) body.tools = rest.tools;
  if (rest.skills) body.skills = rest.skills;
  if (rest.allowedTools) body.allowedTools = rest.allowedTools;
  if (rest.memory) body.memory = rest.memory;
  if (rest.truncation) body.truncation = rest.truncation;
  if (rest.maxIterations != null) body.maxIterations = rest.maxIterations;
  if (rest.maxTokens != null) body.maxTokens = rest.maxTokens;
  if (rest.timeoutSeconds != null) body.timeoutSeconds = rest.timeoutSeconds;
  if (rest.tags) body.tags = rest.tags;

  const result = await client.request({ method: 'POST', path: '/harnesses', body });
  return result as CreateHarnessResult;
}

// ============================================================================
// GetHarness
// ============================================================================

export interface GetHarnessOptions {
  region: string;
  harnessId: string;
}

export interface GetHarnessResult {
  harness: Harness;
}

export async function getHarness(options: GetHarnessOptions): Promise<GetHarnessResult> {
  const client = new AgentCoreApiClient({ region: options.region, plane: 'control' });
  const result = await client.request({ method: 'GET', path: `/harnesses/${options.harnessId}` });
  return result as GetHarnessResult;
}

// ============================================================================
// UpdateHarness
// ============================================================================

export interface UpdateHarnessOptions {
  region: string;
  harnessId: string;
  executionRoleArn?: string;
  environment?: HarnessEnvironmentProvider;
  environmentArtifact?: { optionalValue: HarnessEnvironmentArtifact | null };
  environmentVariables?: Record<string, string>;
  authorizerConfiguration?: { optionalValue: Record<string, unknown> | null };
  model?: HarnessModelConfiguration;
  systemPrompt?: HarnessSystemPrompt;
  tools?: HarnessTool[];
  skills?: HarnessSkill[];
  allowedTools?: string[];
  memory?: { optionalValue: HarnessMemoryConfiguration | null };
  truncation?: HarnessTruncationConfiguration;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  tags?: Record<string, string>;
}

export interface UpdateHarnessResult {
  harness: Harness;
}

export async function updateHarness(options: UpdateHarnessOptions): Promise<UpdateHarnessResult> {
  const { region, harnessId, ...rest } = options;
  const client = new AgentCoreApiClient({ region, plane: 'control' });

  const body: Record<string, unknown> = {
    clientToken: randomUUID(),
  };

  if (rest.executionRoleArn) body.executionRoleArn = rest.executionRoleArn;
  if (rest.environment) body.environment = rest.environment;
  if (rest.environmentArtifact !== undefined) body.environmentArtifact = rest.environmentArtifact;
  if (rest.environmentVariables) body.environmentVariables = rest.environmentVariables;
  if (rest.authorizerConfiguration !== undefined) body.authorizerConfiguration = rest.authorizerConfiguration;
  if (rest.model) body.model = rest.model;
  if (rest.systemPrompt) body.systemPrompt = rest.systemPrompt;
  if (rest.tools) body.tools = rest.tools;
  if (rest.skills) body.skills = rest.skills;
  if (rest.allowedTools) body.allowedTools = rest.allowedTools;
  if (rest.memory !== undefined) body.memory = rest.memory;
  if (rest.truncation) body.truncation = rest.truncation;
  if (rest.maxIterations != null) body.maxIterations = rest.maxIterations;
  if (rest.maxTokens != null) body.maxTokens = rest.maxTokens;
  if (rest.timeoutSeconds != null) body.timeoutSeconds = rest.timeoutSeconds;
  if (rest.tags) body.tags = rest.tags;

  const result = await client.request({ method: 'PATCH', path: `/harnesses/${harnessId}`, body });
  return result as UpdateHarnessResult;
}

// ============================================================================
// DeleteHarness
// ============================================================================

export interface DeleteHarnessOptions {
  region: string;
  harnessId: string;
}

export interface DeleteHarnessResult {
  harness: Harness;
}

export async function deleteHarness(options: DeleteHarnessOptions): Promise<DeleteHarnessResult> {
  const client = new AgentCoreApiClient({ region: options.region, plane: 'control' });
  const result = await client.request({
    method: 'DELETE',
    path: `/harnesses/${options.harnessId}`,
    query: { clientToken: randomUUID() },
  });
  return result as DeleteHarnessResult;
}

// ============================================================================
// ListHarnesses
// ============================================================================

export interface ListHarnessesOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface ListHarnessesResult {
  harnesses: HarnessSummary[];
  nextToken?: string;
}

export async function listHarnesses(options: ListHarnessesOptions): Promise<ListHarnessesResult> {
  const client = new AgentCoreApiClient({ region: options.region, plane: 'control' });
  const query: Record<string, string> = {};
  if (options.maxResults != null) query.maxResults = String(options.maxResults);
  if (options.nextToken) query.nextToken = options.nextToken;

  const result = await client.request({ method: 'GET', path: '/harnesses', query });
  return result as ListHarnessesResult;
}

export async function listAllHarnesses(region: string): Promise<HarnessSummary[]> {
  const all: HarnessSummary[] = [];
  let nextToken: string | undefined;

  do {
    const result = await listHarnesses({ region, maxResults: 100, nextToken });
    all.push(...result.harnesses);
    nextToken = result.nextToken;
  } while (nextToken);

  return all;
}

// ============================================================================
// InvokeHarness (streaming, data plane)
// ============================================================================

export interface InvokeHarnessOptions {
  region: string;
  harnessArn: string;
  runtimeSessionId: string;
  messages: { role: string; content: Record<string, unknown>[] }[];
  model?: HarnessModelConfiguration;
  systemPrompt?: HarnessSystemPrompt;
  tools?: HarnessTool[];
  skills?: HarnessSkill[];
  allowedTools?: string[];
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  actorId?: string;
  /** Bearer token for CUSTOM_JWT auth (bypasses SigV4) */
  bearerToken?: string;
}

// ── Stream event types ──────────────────────────────────────────────────────

export type HarnessStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'tool_result'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filtered'
  | 'malformed_model_output'
  | 'malformed_tool_use'
  | 'interrupted'
  | 'partial_turn'
  | 'model_context_window_exceeded'
  | 'max_iterations_exceeded'
  | 'max_output_tokens_exceeded'
  | 'timeout_exceeded';

export interface ToolUseBlockStart {
  toolUseId: string;
  name: string;
  type?: string;
  serverName?: string;
}

export interface ToolResultBlockStart {
  toolUseId: string;
  status?: string;
}

export type ContentBlockStart =
  | { type: 'toolUse'; toolUse: ToolUseBlockStart }
  | { type: 'toolResult'; toolResult: ToolResultBlockStart };

export type ContentBlockDelta =
  | { type: 'text'; text: string }
  | { type: 'toolUse'; input: string }
  | { type: 'toolResult'; results: Record<string, unknown>[] }
  | { type: 'reasoningContent'; text?: string; signature?: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface StreamMetrics {
  latencyMs: number;
}

export type HarnessStreamEvent =
  | { type: 'messageStart'; role: string }
  | { type: 'contentBlockStart'; contentBlockIndex: number; start: ContentBlockStart }
  | { type: 'contentBlockDelta'; contentBlockIndex: number; delta: ContentBlockDelta }
  | { type: 'contentBlockStop'; contentBlockIndex: number }
  | { type: 'messageStop'; stopReason: HarnessStopReason }
  | { type: 'metadata'; usage: TokenUsage; metrics: StreamMetrics }
  | { type: 'error'; errorType: string; message: string };

export async function* invokeHarness(options: InvokeHarnessOptions): AsyncGenerator<HarnessStreamEvent> {
  const { region, harnessArn, runtimeSessionId, messages, bearerToken, ...overrides } = options;

  const body: Record<string, unknown> = { messages };
  if (overrides.model) body.model = overrides.model;
  if (overrides.systemPrompt) body.systemPrompt = overrides.systemPrompt;
  if (overrides.tools) body.tools = overrides.tools;
  if (overrides.skills) body.skills = overrides.skills;
  if (overrides.allowedTools) body.allowedTools = overrides.allowedTools;
  if (overrides.maxIterations != null) body.maxIterations = overrides.maxIterations;
  if (overrides.maxTokens != null) body.maxTokens = overrides.maxTokens;
  if (overrides.timeoutSeconds != null) body.timeoutSeconds = overrides.timeoutSeconds;
  if (overrides.actorId) body.actorId = overrides.actorId;

  let response: Response;
  if (bearerToken) {
    response = await invokeHarnessWithBearerToken(region, harnessArn, runtimeSessionId, body, bearerToken);
  } else {
    const client = new AgentCoreApiClient({ region, plane: 'data' });
    response = await client.requestRaw({
      method: 'POST',
      path: '/harnesses/invoke',
      query: { harnessArn },
      headers: { 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': runtimeSessionId },
      body,
    });
  }

  if (!response.ok) {
    const errorBody = await response.text();
    const requestId = response.headers.get('x-amzn-requestid') ?? undefined;
    throw new AgentCoreApiError(response.status, errorBody, requestId);
  }

  if (!response.body) return;

  yield* parseEventStream(response.body);
}

async function invokeHarnessWithBearerToken(
  region: string,
  harnessArn: string,
  runtimeSessionId: string,
  body: Record<string, unknown>,
  bearerToken: string
): Promise<Response> {
  const endpoint = resolveEndpoint(region, 'data');
  const url = new URL('/harnesses/invoke', endpoint);
  url.searchParams.set('harnessArn', harnessArn);

  return fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': runtimeSessionId,
    },
    body: JSON.stringify(body),
  });
}

async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<HarnessStreamEvent> {
  const { EventStreamCodec } = await import('@smithy/eventstream-codec');
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  const reader = body.getReader();
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = concatBuffers(buffer, new Uint8Array(value));

      while (buffer.length >= 4) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLength = view.getUint32(0);
        if (buffer.length < totalLength) break;

        const frame = buffer.slice(0, totalLength);
        buffer = buffer.slice(totalLength);

        try {
          const message = codec.decode(frame);
          const headers: Record<string, string> = {};
          for (const [key, val] of Object.entries(message.headers)) {
            headers[key] = String(val.value);
          }

          if (headers[':message-type'] === 'error') {
            yield {
              type: 'error',
              errorType: headers[':error-code'] ?? 'unknown',
              message: headers[':error-message'] ?? 'Unknown error',
            };
            continue;
          }

          if (headers[':message-type'] === 'exception') {
            const exBody = new TextDecoder().decode(message.body);
            let msg = exBody;
            try {
              const parsed = JSON.parse(exBody) as { message?: string };
              msg = parsed.message ?? exBody;
            } catch {
              // use raw body
            }
            yield {
              type: 'error',
              errorType: headers[':exception-type'] ?? 'exception',
              message: msg,
            };
            continue;
          }

          const eventType = headers[':event-type'];
          if (!eventType) continue;

          const bodyText = new TextDecoder().decode(message.body);
          if (!bodyText) continue;

          const event = parseEventPayload(eventType, bodyText);
          if (event) yield event;
        } catch {
          // skip malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

function fromUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function concatBuffers(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function parseEventPayload(eventType: string, bodyText: string): HarnessStreamEvent | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (eventType) {
    case 'messageStart':
      return { type: 'messageStart', role: (payload.role as string) ?? 'assistant' };

    case 'contentBlockStart': {
      const start = (payload.start as Record<string, unknown>) ?? payload;
      return {
        type: 'contentBlockStart',
        contentBlockIndex: (payload.contentBlockIndex as number) ?? 0,
        start: parseContentBlockStart(start),
      };
    }

    case 'contentBlockDelta': {
      const delta = (payload.delta as Record<string, unknown>) ?? payload;
      return {
        type: 'contentBlockDelta',
        contentBlockIndex: (payload.contentBlockIndex as number) ?? 0,
        delta: parseContentBlockDelta(delta),
      };
    }

    case 'contentBlockStop':
      return { type: 'contentBlockStop', contentBlockIndex: (payload.contentBlockIndex as number) ?? 0 };

    case 'messageStop':
      return { type: 'messageStop', stopReason: (payload.stopReason as HarnessStopReason) ?? 'end_turn' };

    case 'metadata':
      return {
        type: 'metadata',
        usage: (payload.usage as TokenUsage) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        metrics: (payload.metrics as StreamMetrics) ?? { latencyMs: 0 },
      };

    case 'internalServerException':
      return {
        type: 'error',
        errorType: 'internalServerException',
        message: (payload.message as string) ?? 'Internal server error',
      };

    case 'validationException':
      return {
        type: 'error',
        errorType: 'validationException',
        message: (payload.message as string) ?? 'Validation error',
      };

    case 'runtimeClientError':
      return {
        type: 'error',
        errorType: 'runtimeClientError',
        message: (payload.message as string) ?? 'Runtime client error',
      };

    default:
      return null;
  }
}

function parseContentBlockStart(start: Record<string, unknown>): ContentBlockStart {
  if ('toolUse' in start) {
    const tu = start.toolUse as ToolUseBlockStart;
    return { type: 'toolUse', toolUse: tu };
  }
  if ('toolResult' in start) {
    const tr = start.toolResult as ToolResultBlockStart;
    return { type: 'toolResult', toolResult: tr };
  }
  return { type: 'toolUse', toolUse: { toolUseId: '', name: 'unknown' } };
}

function parseContentBlockDelta(delta: Record<string, unknown>): ContentBlockDelta {
  if ('text' in delta) {
    return { type: 'text', text: delta.text as string };
  }
  if ('toolUse' in delta) {
    const tu = delta.toolUse as { input: string };
    return { type: 'toolUse', input: tu.input };
  }
  if ('toolResult' in delta) {
    return { type: 'toolResult', results: delta.toolResult as Record<string, unknown>[] };
  }
  if ('reasoningContent' in delta) {
    const rc = delta.reasoningContent as { text?: string; signature?: string };
    return { type: 'reasoningContent', text: rc.text, signature: rc.signature };
  }
  return { type: 'text', text: '' };
}
