import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function EvaluatorScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "evaluator"]} />;
}
