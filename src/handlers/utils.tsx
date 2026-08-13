import type { Context } from "../router";
import type z from "zod";
import type { CoreOptions } from "../core/types";
import { InputValidationError } from "../errors";
import { formatZodError } from "../router/schema";
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

export function parseJsonFlagWithSchema<T>(
  name: string,
  raw: string | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  const parsed = parseJsonFlag<unknown>(name, raw);
  if (parsed === undefined) return undefined;

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid value for option '--${name}': ${formatZodError(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export function parseJsonObjectFlag<T extends object>(
  name: string,
  raw: string | undefined,
): T | undefined {
  const parsed = parseJsonFlag<unknown>(name, raw);
  if (parsed === undefined) return undefined;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InputValidationError(`Option '--${name}' must be a JSON object`);
  }
  return parsed as T;
}

export function parseJsonArrayFlag<T>(name: string, raw: string | undefined): T[] | undefined {
  const parsed = parseJsonFlag<unknown>(name, raw);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) {
    throw new InputValidationError(`Option '--${name}' must be a JSON array`);
  }
  return parsed as T[];
}

export function assertMutuallyExclusiveInputs(
  pairs: readonly (readonly [
    leftName: string,
    leftValue: unknown,
    rightName: string,
    rightValue: unknown,
  ])[],
): void {
  for (const [leftName, leftValue, rightName, rightValue] of pairs) {
    if (leftValue !== undefined && rightValue !== undefined) {
      throw new InputValidationError(`--${leftName} and --${rightName} are mutually exclusive`);
    }
  }
}

// parseTags parses a tags flag that accepts two mutually exclusive forms:
//   - Repeated key=value shorthand: ["env=prod", "team=foo"]
//   - A single JSON object: ['{"env":"prod","team":"foo"}']
// The two forms cannot be mixed. Returns undefined when the input is empty.
export function parseTags(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;

  const first = values[0];
  if (values.length === 1 && first?.trimStart().startsWith("{")) {
    const parsed = parseJsonFlag<Record<string, unknown>>("tags", first);
    if (parsed === undefined) return undefined;
    if (Array.isArray(parsed)) {
      throw new InputValidationError("--tags JSON must be an object of string key-value pairs");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new InputValidationError(
          `--tags value for key '${key}' must be a string, got ${typeof value}`,
        );
      }
    }
    return parsed as Record<string, string>;
  }

  const result: Record<string, string> = {};
  for (const entry of values) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex < 1) {
      throw new InputValidationError(
        `Invalid tag '${entry}': expected key=value format or a single JSON object`,
      );
    }
    result[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
  }
  return result;
}
