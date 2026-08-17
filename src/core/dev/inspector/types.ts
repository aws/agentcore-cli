/**
 * Dependency interfaces for the Inspector HTTP server, owned by the consumer
 * (this package) per the codebase's dependency-inversion rule. Each interface
 * is exactly as wide as the routes that use it; the dev handler wires real
 * implementations (DevSupervisor, InspectorTraceSource, AWS clients) at the
 * edge, and tests inject fakes.
 */
import type { Project } from "../../../handlers/project/types";
import type {
  DeployedCredentialState,
  DeployedGatewayState,
  DeployedHarnessState,
  DeployedMemoryState,
  DeployedAgentState,
  HarnessInvocationOverrides,
  HarnessMessage,
  ListMemoryRecordsQuery,
  MemoryRecordsResponse,
  RetrieveMemoryRecordsRequest,
} from "./api";

/** One managed agent's state, as reported by GET /api/status. */
export interface InspectorAgentStatus {
  name: string;
  buildType: string;
  protocol: string;
  phase: "idle" | "starting" | "running" | "failed";
  port?: number;
  error?: string;
}

/** The slice of the dev supervisor the Inspector routes need. */
export interface InspectorSupervisor {
  snapshot(): InspectorAgentStatus[];
  /** Start an agent by name, resolving once it accepts connections. */
  start(name: string): Promise<{ name: string; port: number }>;
  /** The port and protocol of a running agent, for proxying requests to it. */
  running(name: string): { port: number; protocol: string } | undefined;
}

/** Local OTEL trace reads backing GET /api/traces[/:id]. */
export interface InspectorTraces {
  list(options?: {
    serviceName?: string;
    startTime?: number;
    endTime?: number;
  }): Promise<unknown[]>;
  get(
    traceId: string,
  ): Promise<{ resourceSpans?: unknown[]; resourceLogs?: unknown[] } | undefined>;
}

/** Static SPA assets served for non-API GETs. */
export interface InspectorAssets {
  /** The asset at `path` (e.g. "/index.html"), or undefined when absent. */
  read(path: string): Promise<{ body: Uint8Array; contentType: string } | undefined>;
}

/** A streaming invocation of a deployed AgentCore runtime (?target=deployed). */
export interface DeployedInvocation {
  sessionId?: string;
  /** Chunks are SSE-framed by the server as `data: <json>` events. */
  stream: AsyncIterable<unknown>;
}

/** MCP JSON-RPC operations against a deployed runtime (POST /api/mcp?target=deployed). */
export interface InspectorDeployedMcp {
  initialize(args: {
    agentName?: string;
    targetName?: string;
    sessionId?: string;
  }): Promise<{ sessionId?: string }>;
  listTools(args: {
    agentName?: string;
    targetName?: string;
    sessionId?: string;
  }): Promise<{ tools: unknown[] }>;
  callTool(args: {
    agentName?: string;
    targetName?: string;
    sessionId?: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<string>;
}

/** Memory record reads backing GET /api/memory and POST /api/memory/search. */
export interface InspectorMemory {
  list(args: ListMemoryRecordsQuery): Promise<MemoryRecordsResponse>;
  search(args: RetrieveMemoryRecordsRequest): Promise<MemoryRecordsResponse>;
}

/** CloudWatch trace reads backing GET /api/cloudwatch-traces[/:id]. */
export interface InspectorCloudWatchTraces {
  list(args: {
    agentName?: string;
    harnessName?: string;
    startTime?: number;
    endTime?: number;
  }): Promise<{ success: boolean; traces?: unknown[]; error?: string }>;
  get(args: {
    agentName?: string;
    harnessName?: string;
    traceId: string;
    startTime?: number;
    endTime?: number;
  }): Promise<{ success: boolean; records?: unknown[]; spans?: unknown[]; error?: string }>;
}

/** Deployed harness invocations, streamed back to the SPA as SSE. */
export interface InspectorHarness {
  /**
   * Resolves to the event stream once the invocation is accepted; a rejection
   * before that (e.g. unknown harness) becomes a JSON error response, while
   * stream errors become SSE error events.
   */
  invoke(request: {
    harnessName: string;
    sessionId: string;
    messages: HarnessMessage[];
    userId?: string;
    overrides?: HarnessInvocationOverrides;
  }): Promise<AsyncIterable<unknown>>;
}

/** Deployed resource state merged into GET /api/resources when available. */
export interface InspectorDeployedResources {
  runtimes?: Record<string, DeployedAgentState>;
  harnesses?: Record<string, DeployedHarnessState>;
  memories?: Record<string, DeployedMemoryState>;
  credentials?: Record<string, DeployedCredentialState>;
  gateways?: Record<string, DeployedGatewayState>;
}

/**
 * AWS-backed capabilities. Every member is optional: when one is absent its
 * routes answer 404 `{success:false, error:'... not available'}` and the SPA
 * degrades gracefully.
 */
export interface InspectorAws {
  /** Invoke a deployed runtime (POST /invocations?target=deployed). */
  invokeDeployed?(request: {
    agentName?: string;
    targetName?: string;
    prompt: string;
    sessionId?: string;
    userId?: string;
  }): Promise<DeployedInvocation>;
  mcp?: InspectorDeployedMcp;
  memory?: InspectorMemory;
  cloudwatchTraces?: InspectorCloudWatchTraces;
  harness?: InspectorHarness;
  /** Deployed resource state for GET /api/resources. */
  deployedState?(): Promise<InspectorDeployedResources | undefined>;
}

/** Everything the Inspector request handler is composed from. */
export interface InspectorDeps {
  supervisor: InspectorSupervisor;
  traces?: InspectorTraces;
  assets?: InspectorAssets;
  /** The resolved project; absent outside a project (resource routes 404). */
  project?: Project;
  /** Agent name to pre-select in the UI. */
  selectedAgent?: string;
  aws?: InspectorAws;
}
