import { useNavigate } from "react-router";
import { BatchEvaluationPicker } from "../../../../components/BatchEvaluationPicker";
import type { ScreenProps } from "../../../types";
import { InsightsJob } from "../insightsJob";

export function BatchInsightsListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <BatchEvaluationPicker
      {...props}
      breadcrumb={["agentcore", "eval", "batch-insights", "list"]}
      queryKeyPrefix="batch-insights"
      include={InsightsJob.is}
      loadingMessage="Loading batch insights…"
      emptyMessage="No batch insights found in this Region."
      emptyPageMessage="No batch insights on this page."
      onSelect={(batchEvaluationId) =>
        navigate(`/agentcore/eval/batch-insights/get/${encodeURIComponent(batchEvaluationId)}`)
      }
    />
  );
}
