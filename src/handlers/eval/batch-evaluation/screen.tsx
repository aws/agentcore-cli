import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function BatchEvaluationScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "batch-evaluation"]} />;
}
