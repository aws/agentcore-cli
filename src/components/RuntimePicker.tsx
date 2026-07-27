import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import { formatTimestamp, runtimeIdSuffix } from "./pickerFormatters";
import type { DataTableColumn } from "./ui/data-table";

interface RuntimeRow extends Record<string, unknown> {
  runtimeId: string;
  runtimeName: string;
  runtimeVersion: string;
  status: string;
  lastUpdatedAt: string;
}

export const runtimeColumns = [
  { key: "runtimeName", header: "name", flex: true },
  {
    key: "runtimeId",
    header: "id suffix",
    width: 10,
    minWidth: 10,
    render: runtimeIdSuffix,
  },
  { key: "runtimeVersion", header: "ver", width: 5, minWidth: 3 },
  { key: "status", header: "status", width: 13, minWidth: 13 },
  {
    key: "lastUpdatedAt",
    header: "updated UTC",
    width: 16,
    minWidth: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<RuntimeRow>[];

function toRow(runtime: AgentRuntime): RuntimeRow {
  const runtimeId = runtime.agentRuntimeId ?? "";
  return {
    runtimeId,
    runtimeName: runtime.agentRuntimeName ?? runtimeId,
    runtimeVersion: runtime.agentRuntimeVersion ?? "-",
    status: runtime.status ?? "-",
    lastUpdatedAt: runtime.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimePickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (runtimeId: string) => void;
}

export function RuntimePicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
}: RuntimePickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = () => navigate("/" + breadcrumb.slice(0, -1).join("/"));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["runtimes", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.runtime.listRuntimes(token, pageSize, opts);
        return {
          items: response.agentRuntimes ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={runtimeColumns}
      getValue={(row) => row.runtimeId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading Runtimes…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No Runtimes found in this Region."
      emptyPageMessage="No Runtimes on this page."
    />
  );
}
