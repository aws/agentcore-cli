import type { CoreOptions } from "../types";
import type {
  LogSource,
  ObservableResourceRef,
  ObservabilitySourceResolver,
  ObservabilitySourceResolverRegistry,
  ResolvedObservabilityTarget,
  ResolvedResourceIdentity,
} from "./resolver";
import type {
  InsightsQuery,
  InsightsQueryRow,
  LogSearchQuery,
  LogTailQuery,
  RawLogRecord,
  SourceReader,
} from "./sourceReader";

export interface LogRecord {
  timestamp: Date;
  message: string;
  correlation?: {
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    sessionId?: string;
  };
  severity?: string;
  ingestionTime?: Date;
  source: {
    provider: "cloudwatch";
    resource: ResolvedResourceIdentity;
    logGroupName: string;
    logStreamName?: string;
  };
  raw?: unknown;
}

export interface CoreObservabilityClient {
  searchLogs(
    resource: ObservableResourceRef,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncIterable<LogRecord>;

  tailLogs(
    resource: ObservableResourceRef,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncIterable<LogRecord>;

  queryLogs(
    resource: ObservableResourceRef,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]>;
}

/**
 * Shared entry point for logs. It orchestrates resolution and provider reads,
 * then normalizes provider events into the stable record contract.
 */
export class ObservabilityClient implements CoreObservabilityClient {
  constructor(
    private readonly resolvers: ObservabilitySourceResolverRegistry,
    private readonly sourceReader: SourceReader,
  ) {}

  async *searchLogs(
    resource: ObservableResourceRef,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<LogRecord, void> {
    const target = await this.resolve(resource, options, signal);
    for (const source of target.logs) {
      for await (const raw of this.sourceReader.searchLogs(source, query, options, signal)) {
        yield toLogRecord(target.resource, source, raw);
      }
    }
  }

  async *tailLogs(
    resource: ObservableResourceRef,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncGenerator<LogRecord, void> {
    const target = await this.resolve(resource, options, signal);
    for (const source of target.logs) {
      for await (const raw of this.sourceReader.tailLogs(source, query, options, signal)) {
        yield toLogRecord(target.resource, source, raw);
      }
    }
  }

  async queryLogs(
    resource: ObservableResourceRef,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]> {
    const target = await this.resolve(resource, options, signal);
    const rows: InsightsQueryRow[] = [];
    for (const source of target.logs) {
      rows.push(...(await this.sourceReader.queryLogs(source, query, options, signal)));
    }
    return rows;
  }

  private resolve(
    resource: ObservableResourceRef,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<ResolvedObservabilityTarget> {
    const resolver = this.resolvers[resource.kind] as ObservabilitySourceResolver<typeof resource>;
    return resolver.resolve(resource, options, signal);
  }
}

function toLogRecord(
  resource: ResolvedResourceIdentity,
  source: LogSource,
  record: RawLogRecord,
): LogRecord {
  const metadata = extractCommonMetadata(record.message);
  return {
    timestamp: new Date(record.timestamp),
    message: record.message,
    ...metadata,
    ...(record.ingestionTime !== undefined
      ? { ingestionTime: new Date(record.ingestionTime) }
      : {}),
    source: {
      provider: source.provider,
      resource,
      logGroupName: source.logGroupName,
      ...(record.logStreamName ? { logStreamName: record.logStreamName } : {}),
    },
    raw: record.raw,
  };
}

function extractCommonMetadata(message: string): Pick<LogRecord, "correlation" | "severity"> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const attributes =
    parsed.attributes && typeof parsed.attributes === "object" && !Array.isArray(parsed.attributes)
      ? (parsed.attributes as Record<string, unknown>)
      : {};
  const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const correlation = {
    traceId: stringValue(parsed.traceId),
    spanId: stringValue(parsed.spanId),
    parentSpanId: stringValue(parsed.parentSpanId),
    sessionId: stringValue(parsed.sessionId) ?? stringValue(attributes["session.id"]),
  };
  const hasCorrelation = Object.values(correlation).some((value) => value !== undefined);
  const severity =
    stringValue(parsed.severityText) ?? stringValue(parsed.severity) ?? stringValue(parsed.level);

  return {
    ...(hasCorrelation ? { correlation } : {}),
    ...(severity ? { severity } : {}),
  };
}
