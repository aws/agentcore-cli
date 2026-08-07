import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function MemorySessionScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "memory", "session"]} />;
}
