import { useNavigate } from "react-router";
import { OnlineInsightPicker } from "../../../../components/OnlineInsightPicker";
import type { ScreenProps } from "../../../types";

export function OnlineInsightListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <OnlineInsightPicker
      {...props}
      breadcrumb={["agentcore", "eval", "online-insight", "list"]}
      description="list online insight configs"
      onSelect={(configId) =>
        navigate(`/agentcore/eval/online-insight/get/${encodeURIComponent(configId)}`)
      }
    />
  );
}
