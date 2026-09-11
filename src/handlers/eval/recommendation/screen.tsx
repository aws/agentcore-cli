import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function RecommendationScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "recommendation"]} />;
}
