import { projectCreateTuiCommand } from "../../components/ProjectResourceCreateScreen";
import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

const TUI_ONLY_COMMANDS = [projectCreateTuiCommand("gateway")];

export function GatewayScreen(props: ScreenProps) {
  return (
    <RouterScreen {...props} path={["agentcore", "gateway"]} tuiOnlyCommands={TUI_ONLY_COMMANDS} />
  );
}
