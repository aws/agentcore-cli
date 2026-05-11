# Adding New Telemetry Metrics

## Overview

Every CLI command emits a `command_run` metric with a command key, exit reason, and command-specific attributes. This
guide shows how to add telemetry to a new command.

## Step 1: Register the command in `schemas/command-run.ts`

Add an entry to `COMMAND_SCHEMAS`:

```ts
// No attributes:
'remove.widget': NoAttrs,

// With attributes:
'add.widget': safeSchema({
  widget_type: WidgetType,   // z.enum(), z.boolean(), z.number(), or z.literal() only
  count: Count,
}),
```

`safeSchema` enforces allowed field types at compile time. No `z.string()` fields.

## Step 2: Add enums to `schemas/common-shapes.ts`

```ts
export const WidgetType = z.enum(['basic', 'advanced']);
```

Use `standardize()` to normalize input before recording:

```ts
import { WidgetType, standardize } from '../telemetry/schemas/common-shapes.js';

const type = standardize(WidgetType, userInput);
```

## Step 3: Instrument the command handler

Use **`withCommandRunTelemetry`** — the primary helper for recording telemetry:

```ts
import { withCommandRunTelemetry } from '../telemetry/cli-command-run.js';

const result = await withCommandRunTelemetry('remove.gateway', {}, () => this.remove(name));
```

**Signature:**

```ts
async function withCommandRunTelemetry<C extends Command, R extends OperationResult>(
  command: C,
  attrs: CommandAttrs<C>,
  fn: () => Promise<R>
): Promise<R>;
```

- `command` — the registered command key (e.g. `'add.widget'`)
- `attrs` — attribute object matching the schema registered in Step 1
- `fn` — async callback returning `{ success: true } | { success: false; error: string }`

**Behavior:**

- On success (`{ success: true }`): records success telemetry with `attrs`, returns the result.
- On failure (`{ success: false, error }`): records failure telemetry, returns the result to the caller.
- On throw: records failure telemetry, returns `{ success: false, error }` so callers don't leak unhandled rejections.
- If telemetry is unavailable: runs `fn()` untracked.

**Example with attributes:**

```ts
const result = await withCommandRunTelemetry(
  'add.widget',
  { widget_type: standardize(WidgetType, config.type), count: config.items.length },
  () => widgetPrimitive.add(config)
);

if (!result.success) {
  console.error(result.error);
  process.exit(1);
}
```

### `runCliCommand` (alternative for top-level CLI handlers)

For CLI handlers that own `process.exit`, use `runCliCommand` instead. The callback throws on failure and returns attrs
on success:

```ts
await runCliCommand('add.widget', !!options.json, async () => {
  const result = await widgetPrimitive.add(options);
  if (!result.success) throw new Error(result.error);
  return { widget_type: standardize(WidgetType, options.type), count: options.items.length };
});
```

## Key Points

- Telemetry never crashes the CLI — `standardize()` falls back gracefully, `resilientParse` defaults invalid fields to
  `'unknown'`.
- Prefer `withCommandRunTelemetry` for new code — it returns the `Result` for the caller to handle output and control
  flow.
- Use `runCliCommand` only when the handler owns `process.exit` and prints its own output.
