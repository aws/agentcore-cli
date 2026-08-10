import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

const OMIT = ["create"];

export function GatewayConnectorScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "gateway", "connector"]} omit={OMIT} />;
}
