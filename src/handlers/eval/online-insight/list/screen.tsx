import { useNavigate } from "react-router";
import { OnlineEvalPicker } from "../../../../components/OnlineEvalPicker";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export function OnlineInsightListScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const opts = coreOptsFromCtx(props.ctx);

  return (
    <OnlineEvalPicker
      {...props}
      breadcrumb={["agentcore", "eval", "online-insight", "list"]}
      resourceLabel="online insight configs"
      queryKey={["online-insights", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await props.core.eval.listOnlineInsights(token, pageSize, opts);
        return {
          items: response.onlineEvaluationConfigs ?? [],
          nextToken: response.nextToken,
        };
      }}
      onSelect={(configId) =>
        navigate(`/agentcore/eval/online-insight/get/${encodeURIComponent(configId)}`)
      }
    />
  );
}
