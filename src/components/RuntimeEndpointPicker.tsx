import type { AgentRuntimeEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { PaginatedTablePicker } from "./PaginatedTablePicker";

interface RuntimeEndpointRow extends Record<string, unknown> {
  qualifier: string;
  liveVersion: string;
  targetVersion: string;
  status: string;
  lastUpdatedAt: string;
}

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
}

export function RuntimeEndpointPicker({
  ctx,
  core,
  runtimeId,
  breadcrumb,
  description,
  onSelect,
}: RuntimeEndpointPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = () => navigate(-1);

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
      columns={[
        { key: "qualifier", header: "qualifier" },
        { key: "liveVersion", header: "live" },
        { key: "targetVersion", header: "target" },
        { key: "status", header: "status" },
        { key: "lastUpdatedAt", header: "lastUpdatedAt" },
      ]}
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
