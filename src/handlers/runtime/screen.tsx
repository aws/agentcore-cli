import { projectCreateTuiCommand } from "../../components/ProjectResourceCreateScreen";
import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

const TUI_ONLY_COMMANDS = [projectCreateTuiCommand("runtime")];

export function RuntimeScreen(props: ScreenProps) {
  return (
    <RouterScreen {...props} path={["agentcore", "runtime"]} tuiOnlyCommands={TUI_ONLY_COMMANDS} />
  );
}
