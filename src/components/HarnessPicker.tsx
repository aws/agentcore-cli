import { useNavigate } from "react-router";
import type { HarnessSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { TokenPagedTablePicker } from "./TokenPagedTablePicker";

// HarnessRow is the flat, display-ready shape the table renders. It also satisfies
// DataTable's `T extends Record<string, unknown>` constraint, which the SDK's
// HarnessSummary interface does not.
interface HarnessRow extends Record<string, unknown> {
  harnessId: string;
  harnessName: string;
  updatedAt: string;
  harnessVersion: string;
  status: string;
}

// toRow flattens a HarnessSummary into a HarnessRow, formatting dates.
function toRow(h: HarnessSummary): HarnessRow {
  return {
    harnessId: h.harnessId!,
    harnessName: h.harnessName!,
    updatedAt: h.updatedAt!.toISOString(),
    harnessVersion: h.harnessVersion!,
    status: h.status!,
  };
}

export interface HarnessPickerProps extends ScreenProps {
  // breadcrumb labels the screen the picker is serving (e.g. [..., "list"]).
  breadcrumb: string[];
  // description is the optional subtitle shown after the breadcrumb, telling the
  // user what selecting a harness will do (e.g. "choose a harness to chat with").
  description?: string;
  // onSelect receives the chosen harness's id; the host screen decides where
  // selection leads.
  onSelect: (harnessId: string) => void;
}

// HarnessPicker fetches the caller's harnesses and renders them as a navigable
// table. It is the shared body of every "pick a harness" screen (list, invoke);
// hosts differ only in breadcrumb, subtitle, and what selection does. Esc
// returns to the parent menu, derived from the breadcrumb (e.g. the endpoint
// menu for [..., "endpoint", "list"]).
export function HarnessPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
}: HarnessPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = () => navigate("/" + breadcrumb.slice(0, -1).join("/"));

  return (
    <TokenPagedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["harnesses", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.harness.listHarnesses(token, pageSize, opts);
        return {
          items: response.harnesses ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={(terminalColumns) => {
        const versionWidth = 10;
        const showStatus = terminalColumns >= 70;
        const showUpdatedAt = terminalColumns >= 90;
        const statusWidth = showStatus ? 20 : 0;
        const updatedAtWidth = showUpdatedAt ? 30 : 0;
        const nameWidth = Math.max(
          12,
          terminalColumns - 2 - versionWidth - statusWidth - updatedAtWidth,
        );
        return [
          { key: "harnessName", header: "name", width: nameWidth },
          { key: "harnessVersion", header: "version", width: versionWidth },
          ...(showStatus ? [{ key: "status" as const, header: "status", width: statusWidth }] : []),
          ...(showUpdatedAt
            ? [{ key: "updatedAt" as const, header: "updatedAt", width: updatedAtWidth }]
            : []),
        ];
      }}
      getValue={(row) => row.harnessId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading harnesses…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No harnesses found."
      emptyPageMessage="No harnesses on this page."
    />
  );
}
