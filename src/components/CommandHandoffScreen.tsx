import { useEffect } from "react";
import { useApp } from "ink";
import type { ScreenProps } from "../handlers/types";
import { TuiHandoffKey } from "../tui/handoff";

export interface CommandHandoffScreenProps extends ScreenProps {
  // path is the command's path, e.g. ["agentcore", "dev"].
  path: string[];
}

// CommandHandoffScreen stands in for a command that takes over the terminal
// itself (e.g. `dev`): selecting it closes the TUI and runs the command with no
// arguments, as if the user had typed it.
export function CommandHandoffScreen({ ctx, path }: CommandHandoffScreenProps) {
  const { exit } = useApp();
  useEffect(() => {
    ctx.value(TuiHandoffKey)?.(path.slice(1));
    exit();
  }, [ctx, path, exit]);
  return null;
}
