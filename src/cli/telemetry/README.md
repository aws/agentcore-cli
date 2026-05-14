# Telemetry

## Architecture

```
ATTRIBUTES (common-shapes.ts)    METRICS registry (registry.ts)
         │                                │
         ▼                                ▼
  COMMAND_SCHEMAS (command-run.ts)   TelemetryClient.emit()
         │                                │
         ▼                                ▼
  withCommandRunTelemetry / runCliCommand  MetricSink (otel, filesystem, in-memory)
```

- `TelemetryClient` — generic emitter. Knows nothing about specific metrics.
- `cli-command-run.ts` — command_run-specific logic (timing, error classification).
- `schemas/registry.ts` — all metric definitions. `MetricName` type derived from here.
- `schemas/common-shapes.ts` — all attribute definitions in `ATTRIBUTES` namespace.

## Adding a New Metric

### 1. Define attributes in `schemas/common-shapes.ts`

Skip if reusing existing attributes.

```ts
export const ToolName = z.enum(['read_file', 'write_file', 'search']);
```

Add to the `ATTRIBUTES` object:

```ts
export const ATTRIBUTES = {
  // ...existing
  ToolName,
} as const;
```

### 2. Register the metric in `schemas/registry.ts`

```ts
export const METRICS = {
  'cli.command_run': { ... },
  'cli.mcp_tool_call': {
    instrument: 'histogram',
    schema: safeSchema({
      tool_name: ATTRIBUTES.ToolName,
      success: z.boolean(),
    }),
  },
} as const;
```

### 3. Emit it

```ts
client.emit('cli.mcp_tool_call', durationMs, { tool_name: 'read_file', success: true });
```

Wrong metric name or missing/invalid attrs = compile error.

---

## Adding a New Command (to `cli.command_run`)

### 1. Add the command name to `Command` enum in `schemas/common-shapes.ts`

```ts
export const Command = z.enum([
  // ...existing
  'add.widget',
]);
```

If it introduces a new group, add to `CommandGroup` too.

### 2. Define the command's attribute schema in `schemas/command-run.ts`

```ts
const AddWidgetAttrs = safeSchema({
  widget_type: WidgetType,
  count: Count,
});
```

Add to `COMMAND_SCHEMAS`:

```ts
'add.widget': AddWidgetAttrs,
```

Compile error if the key doesn't match the `Command` enum.

### 3. Instrument the handler

Use `withCommandRunTelemetry`:

```ts
const result = await withCommandRunTelemetry(
  'add.widget',
  { widget_type: standardize(WidgetType, input), count: items.length },
  () => widgetPrimitive.add(config)
);
```

Or `runCliCommand` for top-level CLI handlers that own `process.exit`:

```ts
await runCliCommand('add.widget', !!opts.json, async () => {
  await widgetPrimitive.add(opts);
  return { widget_type: standardize(WidgetType, opts.type), count: opts.items.length };
});
```

---

## Key Rules

- `safeSchema` only allows `z.enum()`, `z.boolean()`, `z.number()`, `z.literal()`. No `z.string()`.
- `standardize(schema, value)` lowercases and validates enum values. Invalid values fall through gracefully.
- `resilientParse` validates each field independently — one bad field defaults to `'unknown'`, never drops the metric.
- Telemetry never crashes the CLI.
