import { useNavigate } from "react-router";
import { OnlineEvalPicker } from "../../../../components/OnlineEvalPicker";
import type { ScreenProps } from "../../../types";

export function OnlineEvalListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <OnlineEvalPicker
      {...props}
      breadcrumb={["agentcore", "eval", "online-eval", "list"]}
      description="list online evaluation configs"
      onSelect={(configId) =>
        navigate(`/agentcore/eval/online-eval/get/${encodeURIComponent(configId)}`)
      }
    />
  );
}
