import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { FormTextArea } from "../../../components/FormTextArea";
import { darkTheme } from "../../../components/ui/_core.js";
import { Select } from "../../../components/ui/select";
import { TextInput } from "../../../components/ui/text-input";
import { InputValidationError } from "../../../errors";
import { renderPayloadTemplate, supportsPayloadTemplate } from "./payloadTemplate";

export type RuntimeInvokeOptions = {
  payloadSource: "Inline" | "File";
  responseDestination: "Console" | "File";
  payloadPath?: string;
  contentType?: string;
  payloadTemplate?: string;
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
};

export type RequestOptionsMode = "overview" | "choice" | "text" | "multiline";

type OptionSection = "Payload" | "Response" | "Runtime" | "MCP" | "Trace";

type Choice = {
  label: string;
  value?: string;
  custom?: boolean;
};

type Row = {
  section: OptionSection;
  field: keyof RuntimeInvokeOptions;
  label: string;
  choices?: Choice[];
  multiline?: boolean;
  placeholder?: string;
  secret?: boolean;
};

const theme = darkTheme;

const choice = (value: string): Choice => ({ label: value, value });

function optionRows(value: RuntimeInvokeOptions, customJwt: boolean, mcp: boolean): Row[] {
  return [
    {
      section: "Payload",
      field: "payloadSource",
      label: "Source",
      choices: [choice("Inline"), choice("File")],
    },
    ...(value.payloadSource === "File"
      ? [{ section: "Payload", field: "payloadPath", label: "File path" } as Row]
      : []),
    {
      section: "Payload",
      field: "contentType",
      label: "Content type",
      choices: [
        choice("application/json"),
        choice("text/plain"),
        choice("application/octet-stream"),
        { label: "Custom", custom: true },
      ],
    },
    ...(value.payloadSource === "Inline" && supportsPayloadTemplate(value.contentType)
      ? [
          {
            section: "Payload",
            field: "payloadTemplate",
            label: "Payload template",
            multiline: true,
            placeholder: '{"prompt":"{{input}}"}',
          } as Row,
        ]
      : []),
    {
      section: "Response",
      field: "accept",
      label: "Accept",
      choices: [
        { label: "Automatic" },
        choice("application/json"),
        choice("text/plain"),
        choice("text/event-stream"),
        choice("application/octet-stream"),
        { label: "Custom", custom: true },
      ],
    },
    {
      section: "Response",
      field: "responseDestination",
      label: "Destination",
      choices: [choice("Console"), choice("File")],
    },
    ...(value.responseDestination === "File"
      ? [{ section: "Response", field: "outputPath", label: "File path" } as Row]
      : []),
    { section: "Runtime", field: "runtimeSessionId", label: "Session ID" },
    { section: "Runtime", field: "runtimeUserId", label: "User ID" },
    {
      section: "Runtime",
      field: "headers",
      label: "Application headers",
      multiline: true,
    },
    ...(customJwt
      ? [{ section: "Runtime", field: "bearerToken", label: "Bearer JWT", secret: true } as Row]
      : []),
    ...(mcp
      ? ([
          { section: "MCP", field: "mcpSessionId", label: "Session ID" },
          { section: "MCP", field: "mcpProtocolVersion", label: "Protocol version" },
          {
            section: "MCP",
            field: "mcpMethod",
            label: "Method",
            choices: [
              choice("tools/call"),
              choice("tools/list"),
              choice("resources/read"),
              choice("prompts/get"),
              { label: "Custom", custom: true },
            ],
          },
          { section: "MCP", field: "mcpName", label: "Name" },
        ] as Row[])
      : []),
    { section: "Trace", field: "traceId", label: "Trace ID" },
    { section: "Trace", field: "traceParent", label: "Traceparent" },
    { section: "Trace", field: "traceState", label: "Tracestate" },
    { section: "Trace", field: "baggage", label: "Baggage" },
  ];
}

function optionSummary(row: Row, value: RuntimeInvokeOptions): string {
  const current = value[row.field];
  if (row.secret) return current ? "Configured" : "Not set";
  if (row.field === "headers") {
    const count = current?.split("\n").filter((line) => line.trim()).length ?? 0;
    return count === 0 ? "Not set" : `${count} ${count === 1 ? "header" : "headers"}`;
  }
  if (row.field === "payloadTemplate") {
    if (!current) return "Not set";
    const lines = current.split("\n").length;
    return `${lines}-line template`;
  }
  if (row.field === "accept") return current || "Automatic";
  return current || "Not set";
}

function selectedChoiceIndex(row: Row, current: string | undefined): number {
  const exact = row.choices!.findIndex((item) => !item.custom && item.value === current);
  if (exact >= 0) return exact;
  if (current === undefined) return 0;
  return Math.max(
    0,
    row.choices!.findIndex((item) => item.custom),
  );
}

export function RequestOptionsScreen({
  value,
  onChange,
  onClose,
  onModeChange,
  customJwt,
  mcp,
}: {
  value: RuntimeInvokeOptions;
  onChange: (value: RuntimeInvokeOptions) => void;
  onClose: () => void;
  onModeChange?: (mode: RequestOptionsMode) => void;
  customJwt: boolean;
  mcp: boolean;
}) {
  const rows = optionRows(value, customJwt, mcp);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<keyof RuntimeInvokeOptions>();
  const [draft, setDraft] = useState("");
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string>();
  const selectedIndex = Math.min(selected, rows.length - 1);
  const row = rows[selectedIndex]!;

  const closeEditor = () => {
    setEditing(undefined);
    setCustom(false);
    setError(undefined);
    onModeChange?.("overview");
  };
  const save = (next?: string) => {
    const normalized = row.field === "payloadTemplate" ? (next?.trim() ? next : undefined) : next;
    if (row.field === "payloadTemplate" && normalized) {
      try {
        renderPayloadTemplate(normalized, "");
      } catch (cause) {
        setError(
          cause instanceof InputValidationError ? cause.message : "Payload template is invalid",
        );
        return;
      }
    }
    onChange({ ...value, [row.field]: normalized });
    closeEditor();
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        closeEditor();
        return;
      }
      if (row.multiline && key.ctrl && input === "d") save(draft);
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(rows.length - 1, current + 1));
      return;
    }
    if (key.return) {
      setDraft(value[row.field] ?? "");
      setCustom(false);
      setError(undefined);
      setEditing(row.field);
      onModeChange?.(row.multiline ? "multiline" : row.choices ? "choice" : "text");
    }
  });

  if (editing) {
    return (
      <Box flexDirection="column">
        {row.multiline ? (
          <FormTextArea
            name={row.label}
            helpText=""
            placeholder={row.placeholder ?? "Name: value"}
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setError(undefined);
            }}
          />
        ) : (
          <Text bold>{row.label}</Text>
        )}
        {row.choices && !custom ? (
          <Box marginTop={1}>
            <Select<number>
              items={row.choices.map((item, index) => ({ label: item.label, value: index }))}
              initialValue={selectedChoiceIndex(row, value[row.field])}
              onSelect={(item) => {
                const selectedChoice = row.choices![item.value]!;
                if (selectedChoice.custom) {
                  const savedChoice = row.choices!.some(
                    (choice) => choice.value === value[row.field],
                  );
                  setDraft(savedChoice ? "" : (value[row.field] ?? ""));
                  setCustom(true);
                  onModeChange?.("text");
                } else {
                  save(selectedChoice.value);
                }
              }}
            />
          </Box>
        ) : !row.multiline ? (
          <Box marginTop={1}>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={save}
              password={row.secret}
              placeholder="Not set"
            />
          </Box>
        ) : null}
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Request options</Text>
      {rows.map((item, index) => {
        const isSelected = index === selectedIndex;
        const firstInSection = index === 0 || rows[index - 1]!.section !== item.section;
        const summary = optionSummary(item, value);
        const empty = summary === "Not set" || summary === "Automatic";
        return (
          <Box key={item.field} flexDirection="column">
            {firstInSection ? (
              <Text bold color={theme.colors.muted}>
                {item.section}
              </Text>
            ) : null}
            <Box>
              <Text color={isSelected ? theme.colors.focus : theme.colors.muted}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Box width={22} flexShrink={0}>
                <Text bold={isSelected}>{item.label}</Text>
              </Box>
              <Text color={empty ? theme.colors.muted : theme.colors.text}>{summary}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
