import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import { TokenPagedTablePicker } from "../../../components/TokenPagedTablePicker";
import type { ScreenProps } from "../../types";
import { coreOptsFromCtx } from "../../utils";

interface RuntimeVersionRow extends Record<string, unknown> {
  version: string;
  status: string;
  lastUpdatedAt: string;
}

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
    <TokenPagedTablePicker
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
      columns={(terminalColumns) => {
        const showUpdatedAt = terminalColumns >= 90;
        const showStatus = terminalColumns >= 60;
        const statusWidth = showStatus ? 20 : 0;
        const updatedAtWidth = showUpdatedAt ? 30 : 0;
        const versionWidth = Math.max(8, terminalColumns - 2 - statusWidth - updatedAtWidth);
        return [
          { key: "version", header: "version", width: versionWidth },
          ...(showStatus ? [{ key: "status" as const, header: "status", width: statusWidth }] : []),
          ...(showUpdatedAt
            ? [
                {
                  key: "lastUpdatedAt" as const,
                  header: "lastUpdatedAt",
                  width: updatedAtWidth,
                },
              ]
            : []),
        ];
      }}
      sortRows={(rows) =>
        [...rows].sort((left, right) => Number(right.version) - Number(left.version))
      }
      getValue={(row) => row.version}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage={`Loading versions for Runtime ${runtimeId}…`}
      errorMessage={(error) => `Error loading versions for Runtime ${runtimeId}: ${error.message}`}
      emptyMessage={`No versions found for Runtime ${runtimeId}.`}
      emptyPageMessage={`No versions on this page for Runtime ${runtimeId}.`}
    />
  );
}
