import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function DatasetScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "dataset"]} />;
}
