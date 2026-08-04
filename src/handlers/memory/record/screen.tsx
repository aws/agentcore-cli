import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function MemoryRecordScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "memory", "record"]} />;
}
