import { RouterScreen } from "../components/RouterScreen";
import type { ScreenProps } from "./types";

export function RootScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore"]} />;
}
