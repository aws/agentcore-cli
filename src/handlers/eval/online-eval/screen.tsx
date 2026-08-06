import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function OnlineEvalScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "online-eval"]} />;
}
