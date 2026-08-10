import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

export function IdentityScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "identity"]} />;
}
