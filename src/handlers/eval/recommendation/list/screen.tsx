import type { RecommendationSummary } from "@aws-sdk/client-bedrock-agentcore";
import { useNavigate } from "react-router";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

// RecommendationRow is the flat, display-ready shape the table renders. It also
// satisfies DataTable's `T extends Record<string, unknown>` constraint, which the
// SDK's RecommendationSummary interface does not.
interface RecommendationRow extends Record<string, unknown> {
  recommendationId: string;
  name: string;
  type: string;
  status: string;
  updatedAt: string;
}

const columns = [
  { key: "name", header: "name", flex: true },
  { key: "type", header: "type", width: 22 },
  { key: "status", header: "status", width: 14 },
  { key: "updatedAt", header: "updated UTC", width: 16, render: formatTimestamp },
] satisfies DataTableColumn<RecommendationRow>[];

function toRow(summary: RecommendationSummary): RecommendationRow {
  const id = summary.recommendationId ?? "";
  return {
    recommendationId: id,
    name: summary.name ?? id,
    type: summary.type ?? "-",
    status: summary.status ?? "-",
    updatedAt: summary.updatedAt?.toISOString() ?? "-",
  };
}

export function RecommendationListScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();
  const breadcrumb = ["agentcore", "eval", "recommendation", "list"];

  return (
    <PaginatedTablePicker
      breadcrumb={breadcrumb}
      description="list recommendations"
      queryKey={["recommendations", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.eval.listRecommendations(token, pageSize, undefined, opts);
        return {
          items: response.recommendationSummaries ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={columns}
      getValue={(row) => row.recommendationId}
      onSelect={(id) => navigate(`/agentcore/eval/recommendation/get/${encodeURIComponent(id)}`)}
      onBack={() => navigate("/" + breadcrumb.slice(0, -1).join("/"))}
      loadingMessage="loading recommendations…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No recommendations found in this Region."
      emptyPageMessage="No recommendations on this page."
    />
  );
}
