import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function MemoryActorScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "memory", "actor"]} />;
}
