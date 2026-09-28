import { Text, useApp } from "ink";
import { useEffect } from "react";
import { CommandKey } from "../router";
import { BrandBanner } from "../components/BrandBanner";
import { RouterScreen } from "../components/RouterScreen";
import { glyphs } from "../components/ui/_core.js";
import type { ScreenProps } from "./types";
import { useNoProjectDetected } from "./project/ProjectGate";

const NO_PROJECT_HINTS = { create: `${glyphs.leftArrow} start here` };
const NO_PROJECT_BANNER = "No project detected - create a new project to get started";

export function RootScreen(props: ScreenProps) {
  const noProjectDetected = useNoProjectDetected(props.core);

  return (
    <RouterScreen
      {...props}
      banner={<BrandBanner />}
      path={["agentcore"]}
      optionHints={noProjectDetected ? NO_PROJECT_HINTS : undefined}
      alert={noProjectDetected ? NO_PROJECT_BANNER : undefined}
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
