import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { FormTextArea } from "../../../components/FormTextArea";
import { Select } from "../../../components/ui/select";
import { TextInput } from "../../../components/ui/text-input";

export interface RuntimeInvokeOptions {
  payloadSource: "Inline" | "File";
  responseDestination: "Console" | "File";
  payloadPath?: string;
  contentType?: string;
  accept?: string;
  outputPath?: string;
  runtimeSessionId?: string;
  runtimeUserId?: string;
  headers?: string;
  bearerToken?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
}

type Row = {
  field: keyof RuntimeInvokeOptions;
  label: string;
  choices?: string[];
  multiline?: boolean;
  secret?: boolean;
};

export function RequestOptionsScreen({
  value,
  onChange,
  onClose,
  customJwt,
  mcp,
}: {
  value: RuntimeInvokeOptions;
  onChange: (value: RuntimeInvokeOptions) => void;
  onClose: () => void;
  customJwt: boolean;
  mcp: boolean;
}) {
  const rows = [
    { field: "payloadSource", label: "Payload source", choices: ["Inline", "File"] },
    ...(value.payloadSource === "File"
      ? [{ field: "payloadPath", label: "Payload path" } as Row]
      : []),
    {
      field: "contentType",
      label: "Content type",
      choices: ["application/json", "text/plain", "application/octet-stream", "Custom"],
    },
    {
      field: "accept",
      label: "Accepted response",
      choices: [
        "text/event-stream",
        "application/json",
        "text/plain",
        "application/octet-stream",
        "Custom",
      ],
    },
    {
      field: "responseDestination",
      label: "Response destination",
      choices: ["Console", "File"],
    },
    ...(value.responseDestination === "File"
      ? [{ field: "outputPath", label: "Response path" } as Row]
      : []),
    { field: "runtimeSessionId", label: "Runtime session ID" },
    { field: "runtimeUserId", label: "Runtime user ID" },
    { field: "headers", label: "Application headers", multiline: true },
    ...(customJwt ? [{ field: "bearerToken", label: "Bearer JWT", secret: true } as Row] : []),
    ...(mcp
      ? [
          { field: "mcpSessionId", label: "MCP session ID" },
          { field: "mcpProtocolVersion", label: "MCP protocol version" },
          {
            field: "mcpMethod",
            label: "MCP method",
            choices: ["tools/call", "tools/list", "resources/read", "prompts/get", "Custom"],
          },
          { field: "mcpName", label: "MCP name" },
        ]
      : []),
    { field: "traceId", label: "Trace ID" },
    { field: "traceParent", label: "Traceparent" },
    { field: "traceState", label: "Tracestate" },
    { field: "baggage", label: "Baggage" },
  ] as Row[];
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<keyof RuntimeInvokeOptions>();
  const [draft, setDraft] = useState("");
  const [custom, setCustom] = useState(false);
  const row = rows[Math.min(selected, rows.length - 1)]!;
  const finish = (next?: string) => {
    if (next !== undefined) onChange({ ...value, [row.field]: next });
    setEditing(undefined);
    setCustom(false);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (editing) finish();
      else onClose();
      return;
    }
    if (editing) {
      if (row.multiline && key.ctrl && input === "d") finish(draft);
      return;
    }
    if (key.upArrow) setSelected((current) => Math.max(0, current - 1));
    if (key.downArrow) setSelected((current) => Math.min(rows.length - 1, current + 1));
    if (key.return) {
      setDraft(value[row.field] ?? "");
      setCustom(false);
      setEditing(row.field);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Request Options</Text>
      {rows.map((item, index) => (
        <Text key={item.field} color={index === selected ? "cyan" : undefined}>
          {index === selected ? "› " : "  "}
          {item.label}:{" "}
          {item.secret && value[item.field]
            ? "*".repeat(value[item.field]!.length)
            : value[item.field]}
        </Text>
      ))}
      {editing === row.field && row.choices && !custom ? (
        <Select
          items={row.choices.map((choice) => ({ label: choice, value: choice }))}
          onSelect={(item) => {
            if (item.value === "Custom") {
              setDraft("");
              setCustom(true);
            } else {
              finish(item.value);
            }
          }}
        />
      ) : editing === row.field && row.multiline ? (
        <FormTextArea
          name={row.label}
          helpText=""
          placeholder="Name: value"
          value={draft}
          onChange={setDraft}
        />
      ) : editing === row.field ? (
        <TextInput value={draft} onChange={setDraft} onSubmit={finish} password={row.secret} />
      ) : null}
    </Box>
  );
}
