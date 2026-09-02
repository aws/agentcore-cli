import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

// AddScreen is the `agentcore project add` menu. RouterScreen reads the
// subcommands straight off the compiled Commander tree, so a new `project add`
// resource appears here without touching this file.
export function AddScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "project", "add"]} />;
}
