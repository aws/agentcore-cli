import { Text, useApp } from "ink";
import { CommandKey } from "../router";
import { useEffect } from "react";
import { RouterScreen } from "../components/RouterScreen";
import type { ScreenProps } from "./types";

export function RootScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore"]} />;
}

export function HelpScreen({ ctx }: ScreenProps) {
  const { exit } = useApp();
  const c = ctx.require(CommandKey);
  const help = c.createHelp();
  const helpText = help.formatHelp(c, help);

  // Empty deps ensures exit only runs once on mount, not on every re-render.
  // https://react.dev/reference/react/useEffect#passing-no-dependency-array-at-all
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(exit, []);

  return <Text>{helpText}</Text>;
}
