import { useNavigate } from "react-router";
import { BatchInsightsPicker } from "../../../../components/BatchInsightsPicker";
import type { ScreenProps } from "../../../types";

export function BatchInsightsListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <BatchInsightsPicker
      {...props}
      breadcrumb={["agentcore", "eval", "batch-insights", "list"]}
      onSelect={(batchEvaluationId) =>
        navigate(`/agentcore/eval/batch-insights/get/${encodeURIComponent(batchEvaluationId)}`)
      }
    />
  );
}
