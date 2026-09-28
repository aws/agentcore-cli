import { Text, useApp } from "ink";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CommandKey, FirstRunKey } from "../router";
import { RouterScreen } from "../components/RouterScreen";
import { glyphs } from "../components/ui/_core.js";
import type { ScreenProps } from "./types";

const FIRST_RUN_HINTS = { create: `${glyphs.leftArrow} start here` };
const NO_PROJECT_BANNER = "No project detected -- create a new project to get started";

export function RootScreen(props: ScreenProps) {
  const from = process.cwd();
  const projectDetected = useQuery({
    queryKey: ["project-detected", from],
    queryFn: async () =>
      (await props.core.projectManager.resolve({
        filePath: from,
      })) !== undefined,
    gcTime: 0,
  });

  return (
    <RouterScreen
      {...props}
      path={["agentcore"]}
      optionHints={props.ctx.value(FirstRunKey) ? FIRST_RUN_HINTS : undefined}
      banner={projectDetected.data === false ? NO_PROJECT_BANNER : undefined}
    />
  );
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
