import type { OnlineEvaluationConfigSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import type { ScreenProps } from "../handlers/types";
import { coreOptsFromCtx } from "../handlers/utils";
import { formatTimestamp } from "./formatTimestamp";
import { PaginatedTablePicker, type TokenPage } from "./PaginatedTablePicker";
import type { DataTableColumn } from "./ui/data-table";

// OnlineEvalRow is the flat, display-ready shape the table renders. It also
// satisfies DataTable's `T extends Record<string, unknown>` constraint, which the
// SDK's OnlineEvaluationConfigSummary interface does not. The list API returns
// only summary fields (name/status/executionStatus/timestamps/insights); richer
// detail like sampling rate and evaluators comes from GetOnlineEvaluationConfig.
interface OnlineEvalRow extends Record<string, unknown> {
  configId: string;
  configName: string;
  status: string;
  executionStatus: string;
  hasInsights: boolean;
  updatedAt: string;
}

export const onlineEvalColumns = [
  { key: "configName", header: "name", flex: true },
  { key: "status", header: "status", width: 12 },
  { key: "executionStatus", header: "execution", width: 11 },
  // #2029: surface whether the config has insights enabled straight from the
  // list summary — no per-row GetOnlineEvaluationConfig call needed.
  { key: "hasInsights", header: "insights", width: 9, render: (value) => (value ? "yes" : "-") },
  {
    key: "updatedAt",
    header: "updated UTC",
    width: 16,
    render: formatTimestamp,
  },
] satisfies DataTableColumn<OnlineEvalRow>[];

function toRow(config: OnlineEvaluationConfigSummary): OnlineEvalRow {
  const id = config.onlineEvaluationConfigId ?? "";
  return {
    configId: id,
    configName: config.onlineEvaluationConfigName ?? id,
    status: config.status ?? "-",
    executionStatus: config.executionStatus ?? "-",
    hasInsights: (config.insights?.length ?? 0) > 0,
    updatedAt: config.updatedAt?.toISOString() ?? "-",
  };
}

export interface OnlineEvalPickerProps extends ScreenProps {
  breadcrumb: string[];
  description?: string;
  onSelect: (configId: string) => void;
  onEscape?: () => void;
  // The online-insight list reuses this picker (same columns, incl. the #2029
  // insights column) but reads from a different Core method and namespace, so
  // the data source and the noun in the status messages are overridable.
  resourceLabel?: string;
  queryKey?: readonly unknown[];
  loadPage?: (
    token: string | undefined,
    pageSize: number,
  ) => Promise<TokenPage<OnlineEvaluationConfigSummary>>;
}

/**
 * Fetches the caller's online evaluation configs and renders them as a navigable
 * table. The shared body of every "pick a config" screen (list, and — in the
 * write TUI — update/pause/resume/delete). Esc returns to the parent menu derived
 * from the breadcrumb unless a host supplies its own onEscape.
 */
export function OnlineEvalPicker({
  ctx,
  core,
  breadcrumb,
  description,
  onSelect,
  onEscape,
  resourceLabel = "online evaluation configs",
  queryKey,
  loadPage,
}: OnlineEvalPickerProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const goBack = onEscape ?? (() => navigate("/" + breadcrumb.slice(0, -1).join("/")));

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description={description}
      queryKey={queryKey ?? ["online-evals", opts.region]}
      loadPage={
        loadPage ??
        (async (token, pageSize) => {
          const response = await core.eval.listOnlineEvaluationConfigs(token, pageSize, opts);
          return {
            items: response.onlineEvaluationConfigs ?? [],
            nextToken: response.nextToken,
          };
        })
      }
      toRow={toRow}
      columns={onlineEvalColumns}
      getValue={(row) => row.configId}
      onSelect={onSelect}
      onBack={goBack}
      loadingMessage={`Loading ${resourceLabel}…`}
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage={`No ${resourceLabel} found in this Region.`}
      emptyPageMessage={`No ${resourceLabel} on this page.`}
    />
  );
}
