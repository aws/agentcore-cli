import { useNavigate } from "react-router";
import type { HarnessSummary } from "@aws-sdk/client-bedrock-agentcore-control";
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

export const harnessColumns = [
  { key: "harnessName", header: "name", flex: true },
  { key: "harnessVersion", header: "version", width: VERSION_WIDTH, align: NUMERIC_ALIGN },
  { key: "status", header: "status", width: STATUS_WIDTH },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<HarnessRow>[];

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

/**
 * Fetches the caller's harnesses and renders them as a navigable table.
 *
 * This is the shared body of every "pick a harness" screen (list, invoke);
 * hosts differ only in breadcrumb, subtitle, and what selection does. Esc
 * returns to the parent menu derived from the breadcrumb.
 */
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
    <PaginatedTablePicker
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
      columns={harnessColumns}
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
