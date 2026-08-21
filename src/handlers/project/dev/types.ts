import type { ProjectRuntime } from "../../../projectSchemas/runtime";

export type DevEvent =
  | { type: "status"; message: string }
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string };

export type DevServerInput = {
  runtime: ProjectRuntime;
  projectRoot: string;
  port: number;
  env?: Record<string, string>;
  signal: AbortSignal;
};

export interface DevRunner {
  run(input: DevServerInput): AsyncGenerator<DevEvent, void>;
}

/** A local OTLP receiver that spawned agents export traces to. */
export interface DevTraceCollector {
  port: number;
  /** Environment variables that point an agent's OTEL SDK at the receiver. */
  envVars: Record<string, string>;
  close(): Promise<void>;
}

export type DevTraceCollectorStarter = (options: {
  tracesDirectory: string;
  signal?: AbortSignal;
  /** Reports a trace-persistence failure (the export is still acked to stop retries). */
  onError?: (error: unknown) => void;
}) => Promise<DevTraceCollector>;
