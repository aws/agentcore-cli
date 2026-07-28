import type { Context } from "../router";
import type { CoreOptions } from "../core/types";
import { InputValidationError } from "../errors";
import { EndpointKey, RegionKey } from "./keys";

// coreOptsFromCtx builds the standard CoreOptions handed to Core operations from
// the values pinned on the context: the resolved region (always present, see the
// withRegion middleware) and the optional --endpoint-url override. Shared by every
// handler that calls into a Core sub-client.
export function coreOptsFromCtx(ctx: Context): CoreOptions {
  return {
    region: ctx.require(RegionKey),
    endpointUrl: ctx.value(EndpointKey),
  };
}

// parseJsonFlag parses a flag's raw string as JSON, typed as the API structure
// the flag mirrors. Structured API parameters (model/tools/memory/...) are
// accepted as JSON documents rather than exploded into dozens of leaf flags;
// deep validation is left to the service. Undefined passes through so optional
// flags stay omitted.
export function parseJsonFlag<T>(name: string, raw: string | undefined): T | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new InputValidationError(
      `Invalid JSON for option '--${name}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
