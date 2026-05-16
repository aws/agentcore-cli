# Telemetry

## Adding a New Metric

### 1. Define attributes in `schemas/common-shapes.ts`

Skip if reusing existing attributes.

```ts
export const ToolName = z.enum(['read_file', 'write_file', 'search']);
```

Add to the `ATTRIBUTES` object using the field name as the key:

```ts
export const ATTRIBUTES = {
  // ...existing
  tool_name: ToolName,
} as const;
```

### 2. Register the metric in `schemas/registry.ts`

Add an entry to `METRICS` with a description, and a corresponding `MetricAttrs` branch:

```ts
export const METRICS = {
  'cli.command_run': { description: 'CLI/TUI Command Execution' },
  'cli.mcp_tool_call': { description: 'MCP tool invocation' },
} as const satisfies MetricRegistry;

export type MetricAttrs<M extends MetricName> = M extends 'cli.command_run'
  ? CommandRunAttrs
  : M extends 'cli.mcp_tool_call'
    ? { tool_name: z.infer<typeof ATTRIBUTES.tool_name>; success: boolean }
    : never;
```

### 3. Emit it

```ts
client.emit('cli.mcp_tool_call', durationMs, { tool_name: 'read_file', success: true });
```

Wrong metric name or missing attrs = compile error.

---

## Adding a New Command (to `cli.command_run`)

### 1. Define the command's attribute schema in `schemas/command-run.ts`

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

The `Command` type and optional fields in `MetricAttrs<'cli.command_run'>` are derived automatically from
`COMMAND_SCHEMAS`.

### 2. Instrument the handler

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
