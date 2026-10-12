import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

export function GatewayScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "gateway"]} />;
}
