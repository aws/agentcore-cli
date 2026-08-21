// Decodes OTLP/HTTP protobuf payloads (the only protocol Python and Node OTEL
// SDKs export over HTTP) with the generated types from @opentelemetry/otlp-transformer.
// The version is pinned: newer releases dropped the generated request decoders.
import root from "@opentelemetry/otlp-transformer/build/src/generated/root";
import { type HttpRequest, type HttpResponse, startHttpServer } from "../../../io";
import { TraceStore } from "./store";
import type { OtlpPayload } from "./types";

/** The slice of a generated protobufjs message type the collector (and its tests) use. */
export interface OtlpMessageType {
  decode(data: Uint8Array): unknown;
  fromObject(object: object): unknown;
  encode(message: unknown): { finish(): Uint8Array };
}

// The generated root's declaration file types it as an opaque protobufjs Root,
// so the real static-message shape is asserted once, here.
const { trace, logs } = (
  root as unknown as {
    opentelemetry: {
      proto: {
        collector: {
          trace: { v1: { ExportTraceServiceRequest: OtlpMessageType } };
          logs: { v1: { ExportLogsServiceRequest: OtlpMessageType } };
        };
      };
    };
  }
).opentelemetry.proto.collector;

export const ExportTraceServiceRequest = trace.v1.ExportTraceServiceRequest;
export const ExportLogsServiceRequest = logs.v1.ExportLogsServiceRequest;
type OtlpDecoder = Pick<OtlpMessageType, "decode">;

export interface OtelCollector {
  /** The loopback port the OTLP/HTTP receiver listens on. */
  port: number;
  /** Reads the traces this collector persists. */
  store: TraceStore;
  /** Environment variables that point an agent's OTEL SDK at this collector. */
  envVars: Record<string, string>;
  /** Stops the receiver. Also invoked by the start signal, if one was given. */
  close(): Promise<void>;
}

export interface StartOtelCollectorOptions {
  /** Directory to persist OTLP JSON Lines files into. */
  tracesDirectory: string;
  /** Closes the collector when aborted. */
  signal?: AbortSignal;
  /** Called when a batch can't be persisted; the export is still acked to stop retries. */
  onError?: (error: unknown) => void;
}

/**
 * Starts an in-process OTLP/HTTP receiver for dev mode on an OS-assigned
 * loopback port. Accepts `POST /v1/traces` and `POST /v1/logs` in protobuf or
 * JSON encoding and appends the raw payloads to a TraceStore.
 */
export async function startOtelCollector(
  options: StartOtelCollectorOptions,
): Promise<OtelCollector> {
  const store = new TraceStore(options.tracesDirectory);
  const server = await startHttpServer((request) => route(request, store, options.onError), {
    signal: options.signal,
  });

  return { port: server.port, store, envVars: otelEnvVars(server.port), close: server.close };
}

async function route(
  request: HttpRequest,
  store: TraceStore,
  onError?: (error: unknown) => void,
): Promise<HttpResponse> {
  if (request.method === "POST" && request.url === "/v1/traces") {
    return ingest(request, store, ExportTraceServiceRequest, onError);
  }
  if (request.method === "POST" && request.url === "/v1/logs") {
    return ingest(request, store, ExportLogsServiceRequest, onError);
  }
  if (request.method === "GET" && request.url === "/") {
    return json(200, { status: "ok" });
  }
  return { status: 404 };
}

async function ingest(
  request: HttpRequest,
  store: TraceStore,
  decoder: OtlpDecoder,
  onError?: (error: unknown) => void,
): Promise<HttpResponse> {
  let payload: OtlpPayload;
  try {
    payload = decodePayload(request.body, String(request.headers["content-type"] ?? ""), decoder);
  } catch {
    return json(400, { error: "Invalid OTLP payload" });
  }
  try {
    await store.append(payload);
  } catch (error) {
    // A persistence failure (disk full, permissions) is the collector's problem,
    // not the agent's: ack the export so the SDK exporter stops retrying the batch
    // forever, and report it once so the user isn't left with silently missing traces.
    onError?.(error);
  }
  return json(200, {});
}

/**
 * Decode an OTLP payload. The JSON round-trip on the protobuf path converts the
 * message to plain objects (protobufjs renders Long as string and bytes as base64).
 */
function decodePayload(body: Buffer, contentType: string, decoder: OtlpDecoder): OtlpPayload {
  if (contentType.includes("application/json")) {
    return JSON.parse(body.toString()) as OtlpPayload;
  }
  return JSON.parse(JSON.stringify(decoder.decode(new Uint8Array(body)))) as OtlpPayload;
}

/**
 * Environment for a spawned agent so its OTEL SDK exports to the collector at
 * `port`. Signal-specific variables are set alongside the generic ones because
 * they take precedence in the SDK — a stray OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
 * from the shell or .env.local must not silently redirect traces elsewhere.
 * Per the OTEL spec, signal-specific endpoints are full URLs (the signal path
 * is only appended to the generic endpoint).
 */
export function otelEnvVars(port: number): Record<string, string> {
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
    OTEL_METRICS_EXPORTER: "none",
    AGENT_OBSERVABILITY_ENABLED: "true",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
    OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED: "true",
  };
}

/**
 * Rewrite loopback OTLP endpoints so a containerized agent can reach the
 * collector on the host. host.docker.internal resolves on Docker Desktop,
 * Finch, and Podman; bare-metal Linux Docker would additionally need
 * `--add-host=host.docker.internal:host-gateway` (matches the reference CLI).
 */
export function rewriteOtelEndpointForContainer(
  env: Record<string, string>,
): Record<string, string> {
  const rewritten = { ...env };
  for (const [key, value] of Object.entries(rewritten)) {
    if (key.startsWith("OTEL_EXPORTER_OTLP") && key.endsWith("_ENDPOINT")) {
      rewritten[key] = value.replace(/127\.0\.0\.1|localhost/, "host.docker.internal");
    }
  }
  return rewritten;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
