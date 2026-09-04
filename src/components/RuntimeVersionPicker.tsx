import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

interface RuntimeVersionRow extends Record<string, unknown> {
  version: string;
  status: string;
  lastUpdatedAt: string;
}

export const runtimeVersionColumns = [
  { key: "version", header: "version", flex: true },
  { key: "status", header: "status", width: 13, minWidth: 6 },
  {
    key: "lastUpdatedAt",
    header: "updated UTC",
    width: 16,
    minWidth: 11,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<RuntimeVersionRow>[];

function toRow(runtime: AgentRuntime): RuntimeVersionRow {
  return {
    version: runtime.agentRuntimeVersion ?? "",
    status: runtime.status ?? "-",
    lastUpdatedAt: runtime.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimeVersionPickerProps extends ScreenProps {
  runtimeId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (version: string) => void;
}

export function RuntimeVersionPicker({
  ctx,
  core,
  runtimeId,
  breadcrumb,
  description,
  onSelect,
}: RuntimeVersionPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = () => navigate(-1);

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["runtime-versions", opts.region, runtimeId]}
      loadPage={async (token, pageSize) => {
        const response = await core.runtime.listRuntimeVersions(runtimeId, token, pageSize, opts);
        return {
          items: response.agentRuntimes ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={runtimeVersionColumns}
      sortRows={(rows) =>
        [...rows].sort((left, right) => Number(right.version) - Number(left.version))
      }
      getValue={(row) => row.version}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage={`loading versions for Runtime ${runtimeId}…`}
      errorMessage={(error) => `Error loading versions for Runtime ${runtimeId}: ${error.message}`}
      emptyMessage={`No versions found for Runtime ${runtimeId}.`}
      emptyPageMessage={`No versions on this page for Runtime ${runtimeId}.`}
    />
  );
}
