import type { AgentRuntime } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { TokenPagedTablePicker } from "./TokenPagedTablePicker";

interface RuntimeRow extends Record<string, unknown> {
  runtimeId: string;
  runtimeName: string;
  runtimeVersion: string;
  status: string;
  lastUpdatedAt: string;
}

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
    <TokenPagedTablePicker
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
      columns={(terminalColumns) => {
        const showId = terminalColumns >= 130;
        const showUpdatedAt = terminalColumns >= 90;
        const showStatus = terminalColumns >= 70;
        const versionWidth = 15;
        const statusWidth = showStatus ? 16 : 0;
        const updatedAtWidth = showUpdatedAt ? 30 : 0;
        const idWidth = showId ? Math.max(30, Math.floor(terminalColumns * 0.36)) : 0;
        const nameWidth = Math.max(
          12,
          terminalColumns - 2 - versionWidth - statusWidth - updatedAtWidth - idWidth,
        );
        return [
          { key: "runtimeName", header: "name", width: nameWidth },
          ...(showId ? [{ key: "runtimeId" as const, header: "id", width: idWidth }] : []),
          { key: "runtimeVersion", header: "latestVersion", width: versionWidth },
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
