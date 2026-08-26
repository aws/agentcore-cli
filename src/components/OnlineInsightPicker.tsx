import type { OnlineEvaluationConfigSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

// OnlineInsightRow is the flat, display-ready shape the table renders. It also
// satisfies DataTable's `T extends Record<string, unknown>` constraint, which the
// SDK's OnlineEvaluationConfigSummary interface does not. ListOnlineInsights
// returns the same summary type as the online-eval list; richer detail like
// sampling rate and clustering comes from GetOnlineInsight.
interface OnlineInsightRow extends Record<string, unknown> {
  configId: string;
  configName: string;
  status: string;
  executionStatus: string;
  updatedAt: string;
}

const onlineInsightColumns = [
  { key: "configName", header: "name", flex: true },
  { key: "status", header: "status", width: 12 },
  { key: "executionStatus", header: "execution", width: 11 },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<OnlineInsightRow>[];

function toRow(config: OnlineEvaluationConfigSummary): OnlineInsightRow {
  const id = config.onlineEvaluationConfigId ?? "";
  return {
    configId: id,
    configName: config.onlineEvaluationConfigName ?? id,
    status: config.status ?? "-",
    executionStatus: config.executionStatus ?? "-",
    updatedAt: config.updatedAt?.toISOString() ?? "-",
  };
}

export interface OnlineInsightPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (configId: string) => void;
  onEscape?: () => void;
}

/**
 * Fetches the caller's online insight configs and renders them as a navigable
 * table. The shared body of every "pick an insight config" screen. Esc returns to
 * the parent menu derived from the breadcrumb unless a host supplies its own
 * onEscape.
 */
export function OnlineInsightPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
}: OnlineInsightPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={["online-insights", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listOnlineInsights(token, pageSize, opts);
        return {
          items: response.onlineEvaluationConfigs ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={onlineInsightColumns}
      getValue={(row) => row.configId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage="Loading online insight configs…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No online insight configs found in this Region."
      emptyPageMessage="No online insight configs on this page."
    />
  );
}
