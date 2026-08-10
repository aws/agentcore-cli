import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function MemoryEventScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "memory", "event"]} />;
}
