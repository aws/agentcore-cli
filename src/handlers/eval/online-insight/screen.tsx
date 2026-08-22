import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function OnlineInsightScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "online-insight"]} />;
}
