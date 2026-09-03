import type {
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  ListAgentRuntimeEndpointsResponse,
  ListAgentRuntimesResponse,
  ListAgentRuntimeVersionsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
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
} from "../../core/observability/types";
import type { CoreOptions } from "../../core/types";
import type { Project } from "../project/types";

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

export type RuntimeInvokeResponse = {
  statusCode: number;
  contentType: string;
  runtimeSessionId?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
  body: AsyncIterable<Uint8Array>;
};

export type RuntimeShellRequest = {
  runtimeArn: string;
  qualifier: string;
  runtimeSessionId?: string;
  shellId?: string;
  bearerToken?: string;
  onReconnect?: () => void;
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
  detach(): Promise<void>;
}

export interface CoreRuntimeClient {
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

/** A project runtime resolved live from its CloudFormation stack outputs. */
export type DeployedRuntime = {
  runtimeId: string;
  /** The deployment target's region — where the stack and log groups live. */
  region: string;
  stackName: string;
  targetName: string;
};

export interface CoreObservabilityClient {
  resolveDeployedRuntime(project: Project, targetName: string): Promise<DeployedRuntime>;
  searchLogs(
    source: LogSource,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncIterable<CloudWatchLogEvent>;
  tailLogs(
    source: LogSource,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncIterable<CloudWatchLogEvent>;
  queryLogs(
    source: LogSource,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]>;
  listTraces(
    source: LogSource,
    query: ListTracesQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceSummary[]>;
  getTrace(
    source: LogSource,
    query: GetTraceQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceRecord[]>;
}
