import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

const OMIT = ["create", "update", "publish", "delete"];

export function DatasetScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "eval", "dataset"]} omit={OMIT} />;
}
