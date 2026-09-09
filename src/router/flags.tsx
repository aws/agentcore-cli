import { Option } from "commander";
import { InputValidationError } from "../errors";
import type { Context } from "./context";
import type { Example, Flag, GlobalFlag } from "./handler";
import { coerce, formatZodError, inspect } from "./schema";

// toOption builds a Commander Option from a flag's schema. A boolean that defaults
// to true is exposed as `--no-<name>`: the behavior is already on, so the only useful
// action is turning it off, which Commander stores under the positive name (e.g.
// `--no-traces` sets `traces=false`). A boolean that defaults off stays `--<name>`.
// Everything else takes a value (`<name>` / variadic `<name...>`); a required
// non-boolean flag is made mandatory; defaults are forwarded.
export function toOption(flag: Flag): Option {
  const info = inspect(flag.schema);
  const long = `--${flag.name}`;

  let token: string;
  if (info.boolean) {
    token = info.hasDefault && info.defaultValue === true ? `--no-${flag.name}` : long;
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
  if (flag.group) {
    option.helpGroup(flag.group);
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

// Indentation of a rendered example: the description sits one level in, the
// command another, and a continued command line one level deeper again so the
// backslash-joined flags read as belonging to the line above.
const EXAMPLE_DESCRIPTION_INDENT = "  ";
const EXAMPLE_COMMAND_INDENT = "    ";
const EXAMPLE_CONTINUATION_INDENT = "      ";

// formatExamples renders a command's worked invocations into the block appended
// after the option list (and after Parameter details, when present). Authors
// supply the shell command only; the layout lives here so every command's
// examples line up identically no matter who wrote them.
export function formatExamples(examples: readonly Example[]): string | undefined {
  if (examples.length === 0) return undefined;

  const blocks = examples.map(({ description, command }) => {
    const body = Array.isArray(command)
      ? command.join(` \\\n${EXAMPLE_CONTINUATION_INDENT}`)
      : command;
    return `${EXAMPLE_DESCRIPTION_INDENT}${description}:\n\n${EXAMPLE_COMMAND_INDENT}${body}`;
  });

  return `\nExamples:\n\n${blocks.join("\n\n")}\n`;
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
    throw new InputValidationError(
      `Invalid value for option '--${flag.name}': ${formatZodError(result.error)}`,
      { cause: result.error },
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
