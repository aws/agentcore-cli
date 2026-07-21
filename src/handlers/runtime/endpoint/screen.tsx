import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function RuntimeEndpointScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "runtime", "endpoint"]} />;
}
