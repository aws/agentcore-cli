import { findAvailablePort } from '../utils';
import { buildTraceDetail, extractFirstTraceInfo, extractTraceMeta } from './transforms';
import type { OtlpResourceLog, OtlpResourceSpan, ProtobufType } from './types';
import fs from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import path from 'node:path';

// Use the generated protobuf types from @opentelemetry/otlp-transformer to decode
// incoming OTLP/HTTP protobuf payloads (the default protocol for Python/Node OTEL SDKs).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const otlpRoot = require('@opentelemetry/otlp-transformer/build/src/generated/root');
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const ExportTraceServiceRequest = otlpRoot.opentelemetry.proto.collector.trace.v1
  .ExportTraceServiceRequest as ProtobufType;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const ExportLogsServiceRequest = otlpRoot.opentelemetry.proto.collector.logs.v1
  .ExportLogsServiceRequest as ProtobufType;

/** Standard OTLP/HTTP port */
const DEFAULT_OTLP_PORT = 4318;

/** Subdirectory for OTLP JSON Lines files */
const OTLP_SUBDIR = 'otlp';

/** File extension for OTLP JSON Lines files */
const OTLP_EXT = '.otlp.jsonl';

/**
 * Lightweight in-process OTLP/HTTP receiver for dev mode.
 *
 * Accepts trace spans (`POST /v1/traces`) and log records (`POST /v1/logs`),
 * persists them as append-only OTLP JSON Lines files, and serves them back
 * with flattened attributes for frontend consumption.
 *
 * No in-memory store — all reads go to disk. This is fine because the frontend
 * only fetches traces on user actions (page load, after invocation, manual refresh).
 */
export class OtelCollector {
  private server: Server | null = null;
  private port = 0;

  private readonly onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly persistDir?: string;

  constructor(options?: {
    onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
    persistTracesDir?: string;
  }) {
    this.onLog = options?.onLog;
    this.persistDir = options?.persistTracesDir;
  }

  /** Start the OTLP receiver. Returns the port it is listening on. */
  async start(): Promise<number> {
    this.port = await findAvailablePort(DEFAULT_OTLP_PORT);

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.handleRequest(req, res);
    });

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.onLog?.('info', `OTEL collector listening on port ${this.port}`);
        if (this.persistDir) {
          this.onLog?.('info', `OTEL trace persistence enabled → ${this.persistDir}`);
        }
        resolve(this.port);
      });
      this.server!.on('error', reject);
    });
  }

  /** Stop the OTLP receiver. */
  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** The port this collector is listening on (0 if not started). */
  getPort(): number {
    return this.port;
  }

  /**
   * List recent traces, optionally filtered by time range.
   * Reads from persisted JSONL files on disk.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTraces(
    agentName: string | undefined,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; traces?: unknown[]; error?: string }> {
    const otlpDir = this.getOtlpDir();
    if (!otlpDir || !fs.existsSync(otlpDir)) {
      return { success: true, traces: [] };
    }

    const now = Date.now();
    const start = startTime ?? now - 12 * 60 * 60 * 1000;
    const end = endTime ?? now;

    const files = fs.readdirSync(otlpDir).filter(f => f.endsWith(OTLP_EXT));

    const traces: {
      traceId: string;
      timestamp: string;
      sessionId?: string;
      spanCount: string;
      resourceSpans?: unknown[];
      resourceLogs?: unknown[];
    }[] = [];

    for (const file of files) {
      try {
        const { resourceSpans, resourceLogs } = this.readTraceFile(path.join(otlpDir, file));

        // Extract metadata from the data
        const meta = extractTraceMeta(resourceSpans, resourceLogs);
        if (!meta.traceId) continue;

        // Apply filters
        if (meta.lastSeen < start || meta.firstSeen > end) continue;
        if (agentName && meta.serviceName !== agentName) continue;

        // Flatten and filter for frontend consumption
        const detail = buildTraceDetail(resourceSpans, resourceLogs);

        traces.push({
          traceId: meta.traceId,
          timestamp: new Date(meta.lastSeen).toISOString(),
          sessionId: meta.sessionId,
          spanCount: String(meta.spanCount),
          ...detail,
        });
      } catch {
        // Skip malformed files
      }
    }

    // Sort newest first
    traces.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { success: true, traces };
  }

  /**
   * Get all spans and logs for a specific trace.
   * Attributes are flattened and noise spans filtered for frontend consumption.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getTraceSpans(
    _agentName: string | undefined,
    traceId: string
  ): Promise<{ success: boolean; resourceSpans?: unknown[]; resourceLogs?: unknown[]; error?: string }> {
    const otlpDir = this.getOtlpDir();
    if (!otlpDir || !fs.existsSync(otlpDir)) {
      return { success: false, error: `No trace data found for trace ID: ${traceId}` };
    }

    // Find the file for this traceId
    const files = fs.readdirSync(otlpDir).filter(f => f.endsWith(OTLP_EXT));
    const match = files.find(f => f.includes(traceId));
    if (!match) {
      return { success: false, error: `No trace data found for trace ID: ${traceId}` };
    }

    try {
      const { resourceSpans, resourceLogs } = this.readTraceFile(path.join(otlpDir, match));
      return { success: true, ...buildTraceDetail(resourceSpans, resourceLogs) };
    } catch {
      return { success: false, error: `Failed to read trace data for trace ID: ${traceId}` };
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'POST' && req.url === '/v1/traces') {
      try {
        const rawBody = await readBodyAsBuffer(req);
        const payload = this.decodePayload(rawBody, req.headers['content-type'] ?? '', ExportTraceServiceRequest);
        this.persistOtlp(payload as { resourceSpans?: OtlpResourceSpan[] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch (err) {
        this.onLog?.('warn', `OTEL ingest error: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid OTLP payload' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/logs') {
      try {
        const rawBody = await readBodyAsBuffer(req);
        const payload = this.decodePayload(rawBody, req.headers['content-type'] ?? '', ExportLogsServiceRequest);
        this.persistOtlp(payload as { resourceLogs?: OtlpResourceLog[] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch (err) {
        this.onLog?.('warn', `OTEL log ingest error: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid OTLP logs payload' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    this.onLog?.('warn', `OTEL collector: unhandled ${req.method} ${req.url}`);
    res.writeHead(404);
    res.end();
  }

  /**
   * Decode an OTLP protobuf or JSON payload.
   * Uses JSON.stringify roundtrip on protobuf to get a plain object
   * (protobufjs toJSON handles Long→string and bytes→base64).
   */
  private decodePayload(raw: Buffer, contentType: string, decoder: ProtobufType): unknown {
    if (contentType.includes('application/json')) {
      return JSON.parse(raw.toString());
    }
    return JSON.parse(JSON.stringify(decoder.decode(new Uint8Array(raw))));
  }

  /** Persist raw OTLP data as a JSON Lines entry, appended to a per-trace file. */
  private persistOtlp(data: { resourceSpans?: OtlpResourceSpan[]; resourceLogs?: OtlpResourceLog[] }): void {
    const otlpDir = this.getOtlpDir();
    if (!otlpDir) return;

    try {
      fs.mkdirSync(otlpDir, { recursive: true });

      const { traceId, serviceName } = extractFirstTraceInfo(data);
      if (!traceId) return;

      const sanitize = (val: string) => val.replace(/[^a-zA-Z0-9_-]/g, '_');
      const prefix = sanitize(serviceName ?? 'dev');
      const filePath = path.join(otlpDir, `${prefix}-${sanitize(traceId)}${OTLP_EXT}`);
      fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
    } catch (err) {
      this.onLog?.('warn', `Failed to persist OTLP: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read and merge all JSONL entries from a trace file into combined resource arrays. */
  private readTraceFile(filePath: string): { resourceSpans: OtlpResourceSpan[]; resourceLogs: OtlpResourceLog[] } {
    const content = fs.readFileSync(filePath, 'utf-8');
    const resourceSpans: OtlpResourceSpan[] = [];
    const resourceLogs: OtlpResourceLog[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { resourceSpans?: OtlpResourceSpan[]; resourceLogs?: OtlpResourceLog[] };
        if (entry.resourceSpans) resourceSpans.push(...entry.resourceSpans);
        if (entry.resourceLogs) resourceLogs.push(...entry.resourceLogs);
      } catch {
        // Skip malformed lines
      }
    }

    return { resourceSpans, resourceLogs };
  }

  private getOtlpDir(): string | undefined {
    return this.persistDir ? path.join(this.persistDir, OTLP_SUBDIR) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBodyAsBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Start an OTEL collector and return it along with the env vars agents need
 * to export traces to it.
 */
export async function startOtelCollector(persistTracesDir: string): Promise<{
  collector: OtelCollector;
  otelEnvVars: Record<string, string>;
}> {
  const collector = new OtelCollector({ persistTracesDir });
  const collectorPort = await collector.start();

  const otelEnvVars: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_METRICS_EXPORTER: 'none',
    AGENT_OBSERVABILITY_ENABLED: 'true',
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true',
    OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED: 'true',
  };

  return { collector, otelEnvVars };
}
