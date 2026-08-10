import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

const OMIT = ["create"];

export function GatewayTargetScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "gateway", "target"]} omit={OMIT} />;
}
