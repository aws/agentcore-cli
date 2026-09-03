import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { GetEvaluatorResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

function useEvaluatorDetail({ ctx, core }: ScreenProps, evaluatorId: string | undefined) {
  const opts = coreOptsFromCtx(ctx);
  return useQuery({
    queryKey: ["evaluator", opts.region, evaluatorId],
    queryFn: () => core.eval.getEvaluator(evaluatorId!, opts),
    enabled: evaluatorId !== undefined,
  });
}

// evaluatorKind names the arm of the evaluatorConfig union in display terms. The
// GetEvaluator response has no type field of its own (unlike the list summary);
// the kind is which arm of the config is populated.
function evaluatorKind(evaluator: GetEvaluatorResponse | undefined): string {
  if (evaluator?.evaluatorConfig?.llmAsAJudge) return "LLM-as-a-Judge";
  if (evaluator?.evaluatorConfig?.codeBased) return "code-based";
  return "-";
}

export function EvaluatorGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { evaluatorId } = useParams();
  const detail = useEvaluatorDetail(props, evaluatorId);
  const evaluator = detail.data;

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "eval", "evaluator", "get", evaluatorId ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        id: evaluator?.evaluatorId ?? "",
        name: evaluator?.evaluatorName ?? "",
        kind: evaluatorKind(evaluator),
        level: evaluator?.level ?? "-",
        status: evaluator?.status ?? "-",
        ...(evaluator?.lockedForModification ? { locked: "yes" } : {}),
        arn: evaluator?.evaluatorArn ?? "",
      }}
      actions={
        evaluatorId && evaluator
          ? [
              {
                name: "detail",
                description: "show the full JSON definition (instructions + rating scale)",
                onSelect: () =>
                  navigate(`/agentcore/eval/evaluator/get/${encodeURIComponent(evaluatorId)}/json`),
              },
            ]
          : []
      }
      loadingLabel="Loading evaluator…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function EvaluatorGetJsonScreen(props: ScreenProps) {
  const { evaluatorId } = useParams();
  const detail = useEvaluatorDetail(props, evaluatorId);

  return (
    <JsonDetail
      breadcrumb={["agentcore", "eval", "evaluator", "get", evaluatorId ?? "", "json"]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="Loading evaluator…"
      onRetry={() => void detail.refetch()}
    />
  );
}
