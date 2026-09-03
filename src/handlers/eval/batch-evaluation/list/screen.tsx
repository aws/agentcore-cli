import { useNavigate } from "react-router";
import { BatchEvaluationPicker } from "../../../../components/BatchEvaluationPicker";
import type { ScreenProps } from "../../../types";

export function BatchEvaluationListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <BatchEvaluationPicker
      {...props}
      breadcrumb={["agentcore", "eval", "batch-evaluation", "list"]}
      description="list batch evaluations"
      onSelect={(batchEvaluationId) =>
        navigate(`/agentcore/eval/batch-evaluation/get/${encodeURIComponent(batchEvaluationId)}`)
      }
    />
  );
}
