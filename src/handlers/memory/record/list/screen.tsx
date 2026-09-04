import type { MemoryContent, MemoryRecordSummary } from "@aws-sdk/client-bedrock-agentcore";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useParams } from "react-router";
import { FormRadioGroup, type FormRadioOption } from "../../../../components/FormRadioGroup";
import { FormTextInput } from "../../../../components/FormTextInput";
import { Layout } from "../../../../components/Layout";
import { MemoryPicker } from "../../../../components/MemoryPicker";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { darkTheme } from "../../../../components/ui/_core";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { useCoreOpts, useRegionNavigate } from "../../../utils";

type RecordScopeKind = "namespace" | "namespace-path";

const scopeOptions = [
  {
    label: "namespace",
    description: "match records whose namespace starts with this prefix",
  },
  {
    label: "namespace path",
    description: "match records under the same namespace hierarchy",
  },
] satisfies FormRadioOption[];

interface MemoryRecordRow extends Record<string, unknown> {
  recordId: string;
  content: string;
  strategyId: string;
  createdAt: string;
}

const recordColumns = [
  { key: "recordId", header: "ID", flex: true },
  { key: "content", header: "content", width: 70, minWidth: 20 },
  { key: "strategyId", header: "strategy", width: 32, minWidth: 16 },
  {
    key: "createdAt",
    header: "created UTC",
    width: 16,
    minWidth: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<MemoryRecordRow>[];

function contentText(content: MemoryContent | undefined): string {
  if (content?.text) return content.text.replace(/\s+/g, " ");
  return "-";
}

function toRow(record: MemoryRecordSummary): MemoryRecordRow {
  return {
    recordId: record.memoryRecordId ?? "",
    content: contentText(record.content),
    strategyId: record.memoryStrategyId ?? "-",
    createdAt: record.createdAt?.toISOString() ?? "-",
  };
}

interface MemoryRecordScopeScreenProps {
  memoryId: string;
}

function MemoryRecordScopeScreen({ memoryId }: MemoryRecordScopeScreenProps) {
  const navigate = useRegionNavigate();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [scope, setScope] = useState("");
  const [submitted, setSubmitted] = useState(false);
  // editing is true while the scope text field has focus; the radio list has
  // focus otherwise.
  const [editing, setEditing] = useState(false);

  useInput((_input, key) => {
    if (!editing) {
      if (key.escape) {
        navigate(-1);
        return;
      }
      if (key.upArrow) {
        setFocusedIndex(0);
        return;
      }
      if (key.downArrow) {
        setFocusedIndex(1);
        return;
      }
      if (key.return) {
        setEditing(true);
      }
      return;
    }

    // The scope field is focused; its TextInput owns text editing.
    if (key.escape || key.upArrow) {
      setEditing(false);
      setSubmitted(false);
      return;
    }
    if (key.return) {
      if (scope.trim() === "") {
        setSubmitted(true);
        return;
      }
      const kind: RecordScopeKind = focusedIndex === 0 ? "namespace" : "namespace-path";
      navigate(
        `/agentcore/memory/record/list/${encodeURIComponent(memoryId)}/${kind}/${encodeURIComponent(scope)}`,
      );
    }
  });

  return (
    <Layout
      breadcrumb={["agentcore", "memory", "record", "list", memoryId]}
      description="choose the namespace scope for the record list"
      keyHints={[
        { key: "↑↓", label: "scope type" },
        { key: "enter", label: "list records" },
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column" gap={1} paddingX={1}>
        <FormRadioGroup
          name="scope type"
          helpText="choose how the service should match record namespaces"
          options={scopeOptions}
          focusedIndex={focusedIndex}
          selectedIndex={editing ? focusedIndex : undefined}
        />
        {editing && (
          <FormTextInput
            name={focusedIndex === 0 ? "namespace" : "namespace path"}
            helpText="the namespace value used to scope this request"
            placeholder="/strategies/strategy-id/actors/actor-id"
            errorText="A namespace value is required."
            value={scope}
            onChange={(value) => {
              setScope(value);
              setSubmitted(false);
            }}
          />
        )}
        {submitted && scope.trim() === "" ? (
          <Text color={darkTheme.colors.error}>A namespace value is required.</Text>
        ) : null}
      </Box>
    </Layout>
  );
}

interface MemoryRecordPickerProps extends ScreenProps {
  memoryId: string;
  scopeKind: RecordScopeKind;
  scope: string;
}

function MemoryRecordPicker({ ctx, core, memoryId, scopeKind, scope }: MemoryRecordPickerProps) {
  const opts = useCoreOpts(ctx);
  const navigate = useRegionNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "memory", "record", "list", memoryId]}
      description={`${scopeKind}: ${scope}`}
      queryKey={["memory-records", opts.region, memoryId, scopeKind, scope]}
      loadPage={async (token, pageSize) => {
        const response = await core.memory.listMemoryRecords(
          {
            memoryId,
            namespace: scopeKind === "namespace" ? scope : undefined,
            namespacePath: scopeKind === "namespace-path" ? scope : undefined,
            maxResults: pageSize,
            nextToken: token,
          },
          opts,
        );
        return {
          items: response.memoryRecordSummaries ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={recordColumns}
      getValue={(row) => row.recordId}
      onSelect={(recordId) =>
        navigate(
          `/agentcore/memory/record/get/${encodeURIComponent(memoryId)}/${encodeURIComponent(recordId)}`,
        )
      }
      onBack={() => navigate(-1)}
      loadingMessage={`loading Memory records for ${memoryId}...`}
      errorMessage={(error) => `Error loading Memory records for ${memoryId}: ${error.message}`}
      emptyMessage={`No Memory records found for ${scopeKind} ${scope}.`}
      emptyPageMessage={`No Memory records on this page for ${scopeKind} ${scope}.`}
    />
  );
}

export function MemoryRecordListScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { memoryId, scopeKind, scope } = useParams();

  if (!memoryId) {
    return (
      <MemoryPicker
        {...props}
        breadcrumb={["agentcore", "memory", "record", "list"]}
        description="choose a Memory to list records for"
        onSelect={(id) => navigate(`/agentcore/memory/record/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  if (scope === undefined || (scopeKind !== "namespace" && scopeKind !== "namespace-path")) {
    return <MemoryRecordScopeScreen memoryId={memoryId} />;
  }

  return <MemoryRecordPicker {...props} memoryId={memoryId} scopeKind={scopeKind} scope={scope} />;
}
