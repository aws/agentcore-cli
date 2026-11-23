/**
 * Dependency interfaces for the Inspector HTTP server, owned by the consumer
 * (this package) per the codebase's dependency-inversion rule. Each interface
 * is exactly as wide as the routes that use it; the dev handler wires real
 * implementations (DevSupervisor, the trace store, bundled assets) at the edge,
 * and tests inject fakes.
 */
import type {
  InvokeHarnessRequest,
  InvokeHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type { DeployableResource, Project } from "../../../handlers/project/types";

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
    limit?: number;
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

/** A resource's state in the dev deployment target, as the SPA badges it. */
export type InspectorDeploymentStatus = "deployed" | "local-only";

/** Looks up one declared resource's deployment status by resource type and name. */
export type InspectorDeploymentLookup = (
  resourceType: DeployableResource,
  name: string,
) => InspectorDeploymentStatus | undefined;

/** A chat turn sent to a deployed Runtime: the SPA's request body, forwarded as-is. */
export interface InspectorDeployedInvokeRequest {
  payload: Uint8Array;
  sessionId: string;
  userId?: string;
}

/** A deployed Runtime's response, streamed back to the SPA like a local agent's. */
export interface InspectorDeployedInvokeResponse {
  statusCode: number;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
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
  /**
   * Resolves where the project's resources stand in the dev deployment target.
   * Rejects when that cannot be determined (never deployed, no credentials),
   * in which case resources carry no deploymentStatus.
   */
  deploymentStatus?: () => Promise<InspectorDeploymentLookup>;
  /** Invokes the deployed Runtime of this name in the dev deployment target. */
  invokeDeployedRuntime?: (
    name: string,
    request: InspectorDeployedInvokeRequest,
    signal: AbortSignal,
  ) => Promise<InspectorDeployedInvokeResponse>;
  invokeHarness?: (
    name: string,
    input: Omit<InvokeHarnessRequest, "harnessArn">,
    signal: AbortSignal,
  ) => Promise<InvokeHarnessResponse>;
}
