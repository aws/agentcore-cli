/**
 * AWS-backed read routes: GET /api/memory, POST /api/memory/search, and
 * GET /api/cloudwatch-traces[/:traceId]. Each answers 404
 * `{success:false, error:'... not available'}` when its capability was not
 * injected, so the SPA degrades gracefully. Ported from the reference
 * memory.ts / cloudwatch-traces.ts handlers.
 */
import type { HttpRequest, HttpResponse } from "../../../io/httpServer";
import type { ListMemoryRecordsQuery, RetrieveMemoryRecordsRequest } from "./api";
import { asString } from "./invocations";
import { apiError, json, parseJsonBody, parseTimeParam } from "./respond";
import type { InspectorDeps } from "./types";

const TRACE_ID_PATTERN = /^[a-fA-F0-9-]+$/;

/** GET /api/memory?memoryName=xxx&(namespace=yyy|namespacePath=yyy)[&strategyId=zzz] */
export async function handleListMemoryRecords(
  deps: InspectorDeps,
  url: URL,
): Promise<HttpResponse> {
  const memory = deps.aws?.memory;
  if (!memory) return apiError(404, "Memory browsing is not available");

  const memoryName = url.searchParams.get("memoryName") ?? undefined;
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const namespacePath = url.searchParams.get("namespacePath") ?? undefined;
  const strategyId = url.searchParams.get("strategyId") ?? undefined;

  if (!memoryName) return apiError(400, "memoryName query parameter is required");
  if (namespace && namespacePath) {
    return apiError(400, "'namespace' and 'namespacePath' query parameters are mutually exclusive");
  }
  if (!namespace && !namespacePath) {
    return apiError(400, "either 'namespace' or 'namespacePath' query parameter is required");
  }

  const query: ListMemoryRecordsQuery = {
    memoryName,
    strategyId,
    ...(namespace ? { namespace } : { namespacePath: namespacePath! }),
  };
  try {
    const result = await memory.list(query);
    return json(result.success ? 200 : 500, result);
  } catch {
    return apiError(500, "Failed to list memory records");
  }
}

/** POST /api/memory/search — semantic search across memory records. */
export async function handleRetrieveMemoryRecords(
  deps: InspectorDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const memory = deps.aws?.memory;
  if (!memory) return apiError(404, "Memory search is not available");

  const parsed = parseJsonBody(request.body);
  const memoryName = asString(parsed?.memoryName);
  const namespace = asString(parsed?.namespace);
  const namespacePath = asString(parsed?.namespacePath);
  const searchQuery = asString(parsed?.searchQuery);
  const strategyId = asString(parsed?.strategyId);

  if (!memoryName) return apiError(400, "memoryName is required");
  if (namespace && namespacePath) {
    return apiError(400, "'namespace' and 'namespacePath' request fields are mutually exclusive");
  }
  if (!namespace && !namespacePath) {
    return apiError(400, "either 'namespace' or 'namespacePath' request field is required");
  }
  if (!searchQuery) return apiError(400, "searchQuery is required");

  const searchRequest: RetrieveMemoryRecordsRequest = {
    memoryName,
    searchQuery,
    strategyId,
    ...(namespace ? { namespace } : { namespacePath: namespacePath! }),
  };
  try {
    const result = await memory.search(searchRequest);
    return json(result.success ? 200 : 500, result);
  } catch {
    return apiError(500, "Failed to search memory records");
  }
}

/** GET /api/cloudwatch-traces?agentName=xxx|harnessName=xxx — list recent traces. */
export async function handleListCloudWatchTraces(
  deps: InspectorDeps,
  url: URL,
): Promise<HttpResponse> {
  const cloudwatch = deps.aws?.cloudwatchTraces;
  if (!cloudwatch) return apiError(404, "CloudWatch traces are not available");

  const selector = parseTraceSelector(url);
  if ("error" in selector) return selector.error;

  try {
    const result = await cloudwatch.list(selector);
    return json(result.success ? 200 : 500, result);
  } catch {
    return apiError(500, "Failed to list CloudWatch traces");
  }
}

/** GET /api/cloudwatch-traces/:traceId?agentName=xxx|harnessName=xxx — full trace data. */
export async function handleGetCloudWatchTrace(
  deps: InspectorDeps,
  url: URL,
): Promise<HttpResponse> {
  const cloudwatch = deps.aws?.cloudwatchTraces;
  if (!cloudwatch) return apiError(404, "CloudWatch traces are not available");

  const traceId = url.pathname.replace("/api/cloudwatch-traces/", "");
  if (!traceId) return apiError(400, "traceId is required in the URL path");
  if (!TRACE_ID_PATTERN.test(traceId)) return apiError(400, "Invalid trace ID format");

  const selector = parseTraceSelector(url);
  if ("error" in selector) return selector.error;

  try {
    const result = await cloudwatch.get({ ...selector, traceId });
    return json(result.success ? 200 : 500, result);
  } catch {
    return apiError(500, "Failed to get CloudWatch trace");
  }
}

function parseTraceSelector(
  url: URL,
):
  | { agentName?: string; harnessName?: string; startTime?: number; endTime?: number }
  | { error: HttpResponse } {
  const agentName = url.searchParams.get("agentName") ?? undefined;
  const harnessName = url.searchParams.get("harnessName") ?? undefined;

  if (!agentName && !harnessName) {
    return { error: apiError(400, "Either agentName or harnessName query parameter is required") };
  }
  if (agentName && harnessName) {
    return { error: apiError(400, "Provide either agentName or harnessName, not both") };
  }

  const startTime = parseTimeParam(url, "startTime");
  if (startTime.error) return { error: startTime.error };
  const endTime = parseTimeParam(url, "endTime");
  if (endTime.error) return { error: endTime.error };

  return { agentName, harnessName, startTime: startTime.value, endTime: endTime.value };
}
