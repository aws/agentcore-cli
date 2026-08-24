import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function BatchInsightsScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "batch-insights"]} />;
}
