import type {
  AuthorizerConfiguration,
  CreateAgentRuntimeResponse,
  DeleteAgentRuntimeResponse,
  GetAgentRuntimeEndpointResponse,
  LifecycleConfiguration,
  NetworkConfiguration,
  ServerProtocol,
  UpdateAgentRuntimeResponse,
  GetAgentRuntimeResponse,
  ListAgentRuntimeEndpointsResponse,
  ListAgentRuntimesResponse,
  ListAgentRuntimeVersionsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandResponse,
} from "@aws-sdk/client-bedrock-agentcore";

export type RuntimeInvokeRequest = {
  runtimeId: string;
  accountId: string;
  qualifier: string;
  payload: Uint8Array;
  contentType: string;
  accept?: string;
  runtimeSessionId?: string;
  runtimeUserId?: string;
  applicationHeaders?: [string, string][];
  bearerToken?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
};

export type RuntimeInvokeResponseMetadata = {
  statusCode: number;
  contentType: string;
  runtimeSessionId?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
};

export type RuntimeInvokeStreamResponse = RuntimeInvokeResponseMetadata & {
  kind: "stream";
  body: AsyncIterable<Uint8Array>;
};

export type RuntimeInvokeRejectedResponse = RuntimeInvokeResponseMetadata & {
  kind: "rejected";
  error: {
    requestId?: string;
  };
};

export type RuntimeInvokeResponse = RuntimeInvokeStreamResponse | RuntimeInvokeRejectedResponse;

export type RuntimeShellRequest = {
  runtimeArn: string;
  qualifier: string;
  runtimeSessionId?: string;
  shellId?: string;
  bearerToken?: string;
  onReconnect?: () => void | Promise<void>;
};

export type RuntimeShellFrame =
  { type: "stdout"; data: Uint8Array } | { type: "stderr"; data: Uint8Array };

export interface RuntimeShellSession extends AsyncIterable<RuntimeShellFrame> {
  readonly runtimeSessionId: string;
  readonly shellId: string;
  readonly kicked: boolean;
  readonly exitCode: number | null;
  send(data: Uint8Array): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

// The settings `agentcore runtime create` sends. A pre-built image Runtime:
// containerUri becomes agentRuntimeArtifact.containerConfiguration. When
// executionRoleArn is omitted, Core provisions a default role scoped to the image.
export type CreateRuntimeInput = {
  runtimeName: string;
  containerUri: string;
  executionRoleArn?: string;
  description?: string;
  protocol?: ServerProtocol;
  environmentVariables?: Record<string, string>;
  networkConfiguration?: NetworkConfiguration;
  authorizerConfiguration?: AuthorizerConfiguration;
  lifecycleConfiguration?: LifecycleConfiguration;
  tags?: Record<string, string>;
};

// UpdateAgentRuntime replaces the whole configuration, so Core reads the current
// version and sends it back with these changes. Omitted fields keep their value.
export type UpdateRuntimeInput = {
  runtimeId: string;
  containerUri?: string;
  executionRoleArn?: string;
  description?: string;
  protocol?: ServerProtocol;
  environmentVariables?: Record<string, string>;
  networkConfiguration?: NetworkConfiguration;
  /** null removes the inbound authorizer (back to AWS IAM). */
  authorizerConfiguration?: AuthorizerConfiguration | null;
  lifecycleConfiguration?: LifecycleConfiguration;
};

export type DeleteRuntimeInput = {
  runtimeId: string;
  /** Also delete the execution role, only when it is the default role this CLI created. */
  deleteExecutionRole?: boolean;
};

export type DeleteRuntimeResult = DeleteAgentRuntimeResponse & {
  executionRole?: { roleArn: string; deleted: boolean };
};

export interface CoreRuntimeClient {
  createRuntime(
    input: CreateRuntimeInput,
    options: CoreOptions,
  ): Promise<CreateAgentRuntimeResponse>;
  updateRuntime(
    input: UpdateRuntimeInput,
    options: CoreOptions,
  ): Promise<UpdateAgentRuntimeResponse>;
  deleteRuntime(input: DeleteRuntimeInput, options: CoreOptions): Promise<DeleteRuntimeResult>;
  /** Resolves a Runtime name (via ListAgentRuntimes), ID, or ARN to its ID. */
  resolveRuntimeId(identifier: string, options: CoreOptions): Promise<string>;
  invokeAgentRuntimeCommand(
    request: InvokeAgentRuntimeCommandRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InvokeAgentRuntimeCommandResponse>;
  invokeRuntime(
    request: RuntimeInvokeRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeInvokeResponse>;
  openRuntimeShell(
    request: RuntimeShellRequest,
    options: CoreOptions,
  ): Promise<RuntimeShellSession>;
  getRuntime(
    id: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetAgentRuntimeResponse>;
  getRuntimeVersion(
    id: string,
    version: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeResponse>;
  getRuntimeEndpoint(
    id: string,
    qualifier: string,
    options: CoreOptions,
  ): Promise<GetAgentRuntimeEndpointResponse>;
  listRuntimes(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimesResponse>;
  listRuntimeVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeVersionsResponse>;
  listRuntimeEndpoints(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListAgentRuntimeEndpointsResponse>;
}
