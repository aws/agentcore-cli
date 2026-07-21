import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function RuntimeVersionScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "runtime", "version"]} />;
}
