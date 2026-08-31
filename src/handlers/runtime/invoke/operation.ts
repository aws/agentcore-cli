import type { CoreOptions } from "../../../core/types";
import type { CoreRuntimeClient, RuntimeInvokeResponse } from "../types";
import { normalizeRuntimeInvokeRequest, type RuntimeInvokeInput } from "./request";

export async function invokeRuntimeTarget(
  client: CoreRuntimeClient,
  input: RuntimeInvokeInput,
  options: CoreOptions,
  signal?: AbortSignal,
): Promise<RuntimeInvokeResponse> {
  const runtime = await client.getRuntime(input.runtimeId, options, signal);
  const request = normalizeRuntimeInvokeRequest(runtime, input);
  return client.invokeRuntime(request, options, signal);
}
