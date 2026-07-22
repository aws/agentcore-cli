import { useNavigate } from "react-router";
import type { HarnessEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { TokenPagedTablePicker } from "./TokenPagedTablePicker";

// EndpointRow is the flat, display-ready shape the table renders.
interface EndpointRow extends Record<string, unknown> {
  endpointName: string;
  liveVersion: string;
  targetVersion: string;
  status: string;
  updatedAt: string;
}

function toRow(e: HarnessEndpoint): EndpointRow {
  return {
    endpointName: e.endpointName!,
    liveVersion: e.liveVersion ?? "-",
    targetVersion: e.targetVersion ?? "-",
    status: e.status!,
    updatedAt: e.updatedAt!.toISOString(),
  };
}

export interface EndpointPickerProps extends ScreenProps {
  // harnessId scopes the listing to one harness's endpoints.
  harnessId: string;
  // breadcrumb labels the screen the picker is serving.
  breadcrumb: string[];
  // description tells the user what selecting an endpoint will do.
  description?: string;
  // onSelect receives the chosen endpoint's name.
  onSelect: (endpointName: string) => void;
  // onEscape overrides what esc does (default: pop back in history). Hosts
  // that embed the picker as an overlay (e.g. the chat's ctrl+t endpoint
  // switch) pass a closer instead.
  onEscape?: () => void;
}

// EndpointPicker fetches a harness's endpoints and renders them as a navigable
// table — the endpoint counterpart of HarnessPicker, shared by every "pick an
// endpoint" screen (list, update, delete). Esc pops back.
export function EndpointPicker({
  ctx,
  core,
  harnessId,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: EndpointPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate(-1));

  return (
    <TokenPagedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["harness-endpoints", opts.region, harnessId]}
      loadPage={async (token, pageSize) => {
        const response = await core.harness.listHarnessEndpoints(harnessId, token, pageSize, opts);
        return {
          items: response.endpoints ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={(terminalColumns) => {
        const liveWidth = 8;
        const showTarget = terminalColumns >= 60;
        const showStatus = terminalColumns >= 70;
        const showUpdatedAt = terminalColumns >= 90;
        const targetWidth = showTarget ? 8 : 0;
        const statusWidth = showStatus ? 20 : 0;
        const updatedAtWidth = showUpdatedAt ? 30 : 0;
        const nameWidth = Math.max(
          12,
          terminalColumns - 2 - liveWidth - targetWidth - statusWidth - updatedAtWidth,
        );
        return [
          { key: "endpointName", header: "name", width: nameWidth },
          { key: "liveVersion", header: "live", width: liveWidth },
          ...(showTarget
            ? [{ key: "targetVersion" as const, header: "target", width: targetWidth }]
            : []),
          ...(showStatus ? [{ key: "status" as const, header: "status", width: statusWidth }] : []),
          ...(showUpdatedAt
            ? [{ key: "updatedAt" as const, header: "updatedAt", width: updatedAtWidth }]
            : []),
        ];
      }}
      getValue={(row) => row.endpointName}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading endpoints…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="This harness has no endpoints yet."
      emptyPageMessage={`No endpoints on this page for harness ${harnessId}.`}
    />
  );
}
