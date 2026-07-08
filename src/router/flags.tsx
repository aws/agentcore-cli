import { Option } from "commander";
import type { Context } from "./context";
import type { Flag, GlobalFlag } from "./handler";
import { coerce, formatZodError, inspect } from "./schema";

// toOption builds a Commander Option from a flag's schema. Booleans become value-less
// toggles; everything else takes a value (`<name>` / variadic `<name...>`). A
// required, non-boolean flag is made mandatory; defaults are forwarded.
export function toOption(flag: Flag): Option {
  const info = inspect(flag.schema);
  const long = `--${flag.name}`;

  let token: string;
  if (info.boolean) {
    token = long;
  } else if (info.variadic) {
    token = `${long} <${flag.name}...>`;
  } else {
    token = `${long} <${flag.name}>`;
  }

  const option = new Option(token, flag.description);
  if (info.hasDefault) {
    option.default(info.defaultValue);
  } else if (info.boolean) {
    option.default(false);
  }
  if (info.required && !info.boolean) {
    option.makeOptionMandatory(true);
  }
  return option;
}

// formatParameterDetails renders the long-form documentation of flags that carry
// `help` into the block appended after Commander's option list (modeled on the
// AWS CLI's OPTIONS section). A flag's first help line is its type annotation
// and shares the line with the flag name; the rest is indented beneath it.
// Returns undefined when no flag has long-form help.
export function formatParameterDetails(flags: Flag[]): string | undefined {
  const detailed = flags.filter((f) => f.help !== undefined);
  if (detailed.length === 0) return undefined;

  const sections = detailed.map((f) => {
    const [annotation = "", ...body] = f.help!.trim().split("\n");
    const indented = body.map((line) => (line ? `      ${line}` : line)).join("\n");
    return `  --${f.name} ${annotation}${indented ? `\n${indented}` : ""}`;
  });

  return `\nParameter details:\n\n${sections.join("\n\n")}\n`;
}

// attributeName mirrors how Commander camelCases an option name into the key it
// stores on the parsed options object (e.g. "harness-id" -> "harnessId").
function attributeName(name: string): string {
  return new Option(`--${name}`).attributeName();
}

// validateFlag coerces and validates a single flag's raw value (read from Commander's
// parsed options) against its schema. On failure it reports via Commander's
// `command.error`, which prints a message and exits (or, with exitOverride,
// throws) — so this returns only on success.
function validateFlag(flag: Flag, opts: Record<string, unknown>): unknown {
  const result = flag.schema.safeParse(coerce(flag.schema, opts[attributeName(flag.name)]));
  if (!result.success) {
    throw new TypeError(
      `Invalid value for option '--${flag.name}': ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

// parseFlags validates a leaf's own flags into a typed-by-name object handed to
// the handler.
export function parseFlags(flags: Flag[], opts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const flag of flags) {
    out[flag.name] = validateFlag(flag, opts);
  }
  return out;
}

// applyGlobalFlags validates each inherited group-level flag and stores it on the
// context under its own key (a GlobalFlag is its own ContextKey), returning the
// extended context. Descendants read these via `ctx.value(theGlobalFlag)`.
export function applyGlobalFlags(
  globalFlags: GlobalFlag[],
  opts: Record<string, unknown>,
  ctx: Context,
): Context {
  let next = ctx;
  for (const globalFlag of globalFlags) {
    next = next.withValue(globalFlag, validateFlag(globalFlag, opts));
  }
  return next;
}
