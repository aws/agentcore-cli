import { useEffect } from "react";
import { useApp } from "ink";
import { RouterScreen } from "../../components/RouterScreen";
import { NotImplementedError } from "../../errors";
import type { ScreenProps } from "../types";

export function ProjectScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "project"]} />;
}

export interface ProjectCommandNotImplementedScreenProps extends ScreenProps {
  // command is the project subcommand the user selected, e.g. "deploy".
  command: string;
}

// ProjectCommandNotImplementedScreen is the landing screen for a project
// subcommand that is listed in the menu but has no screen yet.
//
// Ink's `exit(error)` rejects the `waitUntilExit()` that renderTuiAt awaits, so
// the error travels the normal CLI path: the TUI tears down, the terminal is
// restored, and runWithExitCode prints it and sets the exit code. Throwing
// during render would instead surface a React stack trace.
export function ProjectCommandNotImplementedScreen({
  command,
}: ProjectCommandNotImplementedScreenProps) {
  const { exit } = useApp();

  useEffect(() => {
    exit(
      new NotImplementedError(
        `'agentcore project ${command}' has no interactive screen yet; ` +
          `run 'agentcore project ${command} --help' to use it from the command line`,
      ),
    );
  }, [exit, command]);

  return null;
}
