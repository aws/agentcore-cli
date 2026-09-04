import type { AgentRuntimeEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import { FLAG_ALIGN, STATUS_WIDTH, TIMESTAMP_WIDTH, type DataTableColumn } from "./ui/data-table";

interface RuntimeEndpointRow extends Record<string, unknown> {
  qualifier: string;
  liveVersion: string;
  targetVersion: string;
  status: string;
  lastUpdatedAt: string;
}

export const runtimeEndpointColumns = [
  { key: "qualifier", header: "qualifier", flex: true },
  { key: "liveVersion", header: "live", width: 6, minWidth: 5, align: FLAG_ALIGN },
  { key: "targetVersion", header: "target", width: 6, align: FLAG_ALIGN },
  { key: "status", header: "status", width: STATUS_WIDTH },
  {
    key: "lastUpdatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<RuntimeEndpointRow>[];

function toRow(endpoint: AgentRuntimeEndpoint): RuntimeEndpointRow {
  return {
    qualifier: endpoint.name ?? endpoint.id ?? "",
    liveVersion: endpoint.liveVersion ?? "-",
    targetVersion: endpoint.targetVersion ?? "-",
    status: endpoint.status ?? "-",
    lastUpdatedAt: endpoint.lastUpdatedAt?.toISOString() ?? "-",
  };
}

export interface RuntimeEndpointPickerProps extends ScreenProps {
  runtimeId: string;
  breadcrumb: string[];
  description?: string;
  onSelect: (qualifier: string) => void;
  onEscape?: () => void;
}

export function RuntimeEndpointPicker({
  ctx,
  core,
  runtimeId,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: RuntimeEndpointPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate(-1));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["runtime-endpoints", opts.region, runtimeId]}
      loadPage={async (token, pageSize) => {
        const response = await core.runtime.listRuntimeEndpoints(runtimeId, token, pageSize, opts);
        return {
          items: response.runtimeEndpoints ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={runtimeEndpointColumns}
      getValue={(row) => row.qualifier}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage={`Loading endpoints for Runtime ${runtimeId}…`}
      errorMessage={(error) => `Error loading endpoints for Runtime ${runtimeId}: ${error.message}`}
      emptyMessage="This Runtime has no endpoints."
      emptyPageMessage={`No endpoints on this page for Runtime ${runtimeId}.`}
    />
  );
}
