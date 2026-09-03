import { Text, useApp } from "ink";
import { useEffect } from "react";
import { CommandKey } from "../router";
import { RouterScreen } from "../components/RouterScreen";
import type { ScreenProps } from "./types";

export function RootScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore"]} />;
}

// HelpScreen is the final safety net for a route that does not resolve to an
// exact command. It prints the launching command's standard Commander help and
// exits the TUI, preserving the original fallback behavior.
export function HelpScreen({ ctx }: ScreenProps) {
  const { exit } = useApp();
  const command = ctx.require(CommandKey);
  const help = command.createHelp();
  const helpText = help.formatHelp(command, help);

  // Empty deps ensures exit only runs once on mount, not on every re-render.
  // https://react.dev/reference/react/useEffect#passing-no-dependency-array-at-all
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(exit, []);

  return <Text>{helpText}</Text>;
}
