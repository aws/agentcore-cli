import { useNavigate } from "react-router";
import { EvaluatorPicker } from "../../../../components/EvaluatorPicker";
import type { ScreenProps } from "../../../types";

export function EvaluatorListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <EvaluatorPicker
      {...props}
      breadcrumb={["agentcore", "eval", "evaluator", "list"]}
      description="list evaluators"
      onSelect={(evaluatorId) =>
        navigate(`/agentcore/eval/evaluator/get/${encodeURIComponent(evaluatorId)}`)
      }
    />
  );
}
