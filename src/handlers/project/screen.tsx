import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

// ProjectScreen is the `agentcore project` menu. Subcommands without a screen
// are listed below a divider and open their help.
export function ProjectScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "project"]} showCliOnly />;
}
