import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function AbTestScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "ab-test"]} />;
}
