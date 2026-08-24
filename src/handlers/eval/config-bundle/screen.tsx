import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function ConfigBundleScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "config-bundle"]} />;
}
