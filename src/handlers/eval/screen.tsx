import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

export function EvalScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval"]} />;
}
