import { useNavigate } from "react-router";
import type { HarnessEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import { FLAG_ALIGN, STATUS_WIDTH, TIMESTAMP_WIDTH, type DataTableColumn } from "./ui/data-table";

// EndpointRow is the flat, display-ready shape the table renders.
interface EndpointRow extends Record<string, unknown> {
  endpointName: string;
  liveVersion: string;
  targetVersion: string;
  status: string;
  updatedAt: string;
}

export const harnessEndpointColumns = [
  { key: "endpointName", header: "name", flex: true },
  { key: "liveVersion", header: "live", width: 6, minWidth: 5, align: FLAG_ALIGN },
  { key: "targetVersion", header: "target", width: 6, align: FLAG_ALIGN },
  { key: "status", header: "status", width: STATUS_WIDTH },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: TIMESTAMP_WIDTH,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<EndpointRow>[];

function toRow(e: HarnessEndpoint): EndpointRow {
  return {
    endpointName: e.endpointName!,
    liveVersion: e.liveVersion ?? "-",
    targetVersion: e.targetVersion ?? "-",
    status: e.status!,
    updatedAt: e.updatedAt!.toISOString(),
  };
}

export interface HarnessEndpointPickerProps extends ScreenProps {
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

/**
 * Fetches a harness's endpoints and renders them as a navigable table.
 *
 * This is the endpoint counterpart of HarnessPicker, shared by every "pick an
 * endpoint" screen (list, update, delete). Esc pops back.
 */
export function HarnessEndpointPicker({
  ctx,
  core,
  harnessId,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: HarnessEndpointPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate(-1));

  return (
    <PaginatedTablePicker
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
      columns={harnessEndpointColumns}
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
