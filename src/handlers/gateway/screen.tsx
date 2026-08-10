import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

const OMIT = ["create"];

export function GatewayScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "gateway"]} omit={OMIT} />;
}
