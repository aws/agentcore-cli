import { projectCreateTuiCommand } from "../../components/ProjectResourceCreateScreen";
import { RouterScreen } from "../../components/RouterScreen";
import type { ScreenProps } from "../types";

const TUI_ONLY_COMMANDS = [projectCreateTuiCommand("memory")];

export function MemoryScreen(props: ScreenProps) {
  return (
    <RouterScreen {...props} path={["agentcore", "memory"]} tuiOnlyCommands={TUI_ONLY_COMMANDS} />
  );
}
