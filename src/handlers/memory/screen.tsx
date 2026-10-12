import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

export function MemoryScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "memory"]} />;
}
