import z from "zod";
import { createHandler, argument, GlobalConfigAccessorKey } from "../../router";
import { JsonRendererKey } from "../../tui";
import { InputValidationError } from "../../errors";
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from "../../globalConfig";

/*
 * read/write global configuration values. ex. telemetry settings, endpoint overrides, etc.
 * Ex.
 * `config [key] [value]` sets key to value.
 * `config [key]` prints the value with key.
 * `config` prints the full config.
 */
export const createConfigHandler = () =>
  createHandler({
    name: "config",
    description: "read/write global config values",
    arguments: [
      argument(
        "key",
        "config key in JSON path notation (e.g. telemetry.enabled)",
        z.enum(getKeys(DEFAULT_GLOBAL_CONFIG)).optional(),
      ),
      argument("value", "value to set for the key", z.string().optional()),
    ],
    handle: async (ctx, _flags, args) => {
      const globalConfigAccessor = ctx.require(GlobalConfigAccessorKey);
      const jsonRenderer = ctx.require(JsonRendererKey);

      const globalConfig = await globalConfigAccessor.get();
      // isFirstRun is not user controlled, so strip from the output.
      if (!args.key) {
        const { isFirstRun: _isFirstRun, ...persistedConfig } = globalConfig;
        jsonRenderer.renderJson(persistedConfig);
        return;
      }

      // print entire value at key when value is missing.
      if (!args.value) {
        const scopedConfig = getAtPath(globalConfig, args.key);
        jsonRenderer.renderJson(scopedConfig);
        return;
      }
      const coercedValue = coerceValue(
        getAtPath(DEFAULT_GLOBAL_CONFIG, args.key),
        args.value,
        args.key,
      );

      // update value at key with given value.
      await globalConfigAccessor.set(
        setAtPath(globalConfig, args.key, coercedValue) as GlobalConfig,
      );

      jsonRenderer.renderJson(coercedValue);
    },
  });

function coerceValue(current: unknown, raw: string, path: string): unknown {
  switch (typeof current) {
    case "string":
      return raw;

    case "boolean": {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
      throw new InputValidationError(`Cannot coerce "${raw}" to boolean at "${path}"`);
    }

    case "number": {
      const trimmed = raw.trim();
      const n = Number(trimmed);
      if (trimmed === "" || Number.isNaN(n)) {
        throw new InputValidationError(`Cannot coerce "${raw}" to number at "${path}"`);
      }
      return n;
    }

    case "object": {
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new InputValidationError(`Cannot coerce "${raw}" to object at "${path}"`, {
          cause: e,
        });
      }
    }

    default:
      throw new InputValidationError(`Unsupported target type "${typeof current}" at "${path}"`);
  }
}
/** Type guard that narrows `value` to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retrieves a nested value from `obj` using dot-notation (e.g. `"telemetry.enabled"`). */
function getAtPath(obj: object, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), obj);
}

/** Returns a shallow-cloned object with `value` set at the given dot-notation `path`. */
function setAtPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split(".");
  if (keys.length === 0) return obj;
  const head = keys[0]!;
  if (keys.length === 1) return { ...obj, [head]: value };
  return {
    ...obj,
    [head]: setAtPath(
      isRecord(obj[head]) ? (obj[head] as Record<string, unknown>) : {},
      keys.slice(1).join("."),
      value,
    ),
  };
}

function getKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.keys(obj).reduce<string[]>((acc, key) => {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return [...acc, fullPath, ...getKeys(value as Record<string, unknown>, fullPath)];
    }
    return [...acc, fullPath];
  }, []);
}
