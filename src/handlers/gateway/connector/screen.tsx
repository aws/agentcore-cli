import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function GatewayConnectorScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "gateway", "connector"]} />;
}
