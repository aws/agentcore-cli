/**
 * Dependency interfaces for the Inspector HTTP server, owned by the consumer
 * (this package) per the codebase's dependency-inversion rule. Each interface
 * is exactly as wide as the routes that use it; the dev handler wires real
 * implementations (DevSupervisor, the trace store, bundled assets) at the edge,
 * and tests inject fakes.
 */
import type { Project } from "../../../handlers/project/types";

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

/** Everything the Inspector request handler is composed from. */
export interface InspectorDeps {
  supervisor: InspectorSupervisor;
  traces?: InspectorTraces;
  assets?: InspectorAssets;
  /** The resolved project; absent outside a project (resource routes 404). */
  project?: Project;
  /** Agent name to pre-select in the UI. */
  selectedAgent?: string;
}
