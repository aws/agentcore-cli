import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

const OMIT = ["create"];

export function GatewayRuleScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "gateway", "rule"]} omit={OMIT} />;
}
