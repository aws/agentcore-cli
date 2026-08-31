import type {
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  ListAgentRuntimeEndpointsResponse,
  ListAgentRuntimesResponse,
  ListAgentRuntimeVersionsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
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

export interface CoreRuntimeClient {
  invokeRuntime(
    request: RuntimeInvokeRequest,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<RuntimeInvokeResponse>;
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

/** One CloudWatch log event from a runtime's log group. */
export type RuntimeLogEvent = {
  /** Epoch milliseconds. */
  timestamp: number;
  message: string;
};

/** A project runtime resolved live from its CloudFormation stack outputs. */
export type DeployedRuntime = {
  runtimeId: string;
  /** The deployment target's region — where the stack and log groups live. */
  region: string;
  stackName: string;
  targetName: string;
};

export type StreamRuntimeLogsInput = {
  runtimeId: string;
  /** CloudWatch Logs filter pattern applied server-side. */
  filterPattern?: string;
};

export type SearchRuntimeLogsInput = {
  runtimeId: string;
  /** Window start, epoch milliseconds (inclusive). */
  startTimeMs: number;
  /** Window end, epoch milliseconds (inclusive). */
  endTimeMs: number;
  /** CloudWatch Logs filter pattern applied server-side. */
  filterPattern?: string;
  /** Maximum number of events to yield. */
  limit?: number;
};

/** One trace aggregated from a runtime's telemetry, newest first. */
export type TraceSummary = {
  traceId: string;
  /** Last-seen time as reported by Logs Insights (epoch ms rendered as a string). */
  timestamp: string;
  sessionId?: string;
  spanCount?: string;
};

/**
 * One raw log record belonging to a trace. `@message` is the parsed JSON body
 * when it parses, otherwise the original string; other Insights fields (e.g.
 * `@timestamp`, `@ptr`) pass through as returned.
 */
export type TraceRecord = Record<string, unknown>;

export type ListRuntimeTracesInput = {
  runtimeId: string;
  /** Window start, epoch milliseconds. */
  startTimeMs: number;
  /** Window end, epoch milliseconds. */
  endTimeMs: number;
  /** Maximum number of traces to return. */
  limit: number;
};

export type GetRuntimeTraceInput = {
  runtimeId: string;
  traceId: string;
  /** Window start, epoch milliseconds. */
  startTimeMs: number;
  /** Window end, epoch milliseconds. */
  endTimeMs: number;
};

export interface CoreObservabilityClient {
  resolveDeployedRuntime(project: Project, targetName: string): Promise<DeployedRuntime>;
  /** Live-tails the runtime's log group until `signal` aborts. */
  streamRuntimeLogs(
    input: StreamRuntimeLogsInput,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncGenerator<RuntimeLogEvent, void>;
  /** Searches the runtime's log group over a time window, oldest to newest. */
  searchRuntimeLogs(
    input: SearchRuntimeLogsInput,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeLogEvent, void>;
  /** Lists recent traces in the runtime's log group, newest first. */
  listRuntimeTraces(input: ListRuntimeTracesInput, options: CoreOptions): Promise<TraceSummary[]>;
  /** Downloads every log record of one trace, oldest first. */
  getRuntimeTrace(input: GetRuntimeTraceInput, options: CoreOptions): Promise<TraceRecord[]>;
}
