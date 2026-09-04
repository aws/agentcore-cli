import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import {
  NUMERIC_ALIGN,
  STATUS_WIDTH,
  TIMESTAMP_WIDTH,
  VERSION_WIDTH,
  type DataTableColumn,
} from "./ui/data-table";

interface RuntimeRow extends Record<string, unknown> {
  runtimeId: string;
  runtimeVersion: string;
  status: string;
  lastUpdatedAt: string;
}

// The control plane derives a Runtime's ID from its name (`orders-Ab12Cd34Ef`),
// so the ID column carries the name already; splitting the suffix out would
// only show the same value twice.
export const runtimeColumns = [
  { key: "runtimeId", header: "id", flex: true },
  { key: "runtimeVersion", header: "version", width: VERSION_WIDTH, align: NUMERIC_ALIGN },
  { key: "status", header: "status", width: STATUS_WIDTH },
  {
    key: "lastUpdatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<RuntimeRow>[];

function toRow(runtime: AgentRuntime): RuntimeRow {
  const runtimeId = runtime.agentRuntimeId ?? runtime.agentRuntimeName ?? "";
  return {
    runtimeId,
    runtimeVersion: runtime.agentRuntimeVersion ?? "-",
    status: runtime.status ?? "-",
    lastUpdatedAt: runtime.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimePickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (runtimeId: string) => void;
  onEscape?: () => void;
}

export function RuntimePicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: RuntimePickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

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
