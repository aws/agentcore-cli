import { Text, useApp } from "ink";
import { useEffect } from "react";
import { CommandKey } from "../router";
import { BrandBanner } from "../components/BrandBanner";
import { resolveCommand, RouterScreen } from "../components/RouterScreen";
import { useTuiUpdate } from "../components/TuiUpdateContext";
import { glyphs } from "../components/ui/_core.js";
import type { ScreenProps } from "./types";
import { LoadingFrame, useProjectDetected } from "./project/ProjectGate";

const NO_PROJECT_HINTS = { create: `${glyphs.leftArrow} start here` };
const ROOT_CLI_SECTION_COMMANDS = ["update"];
const NO_PROJECT_ALERT = "No project detected - create a new project to get started";
const PROJECT_HIDDEN_OPTIONS = ["create"];
const PROJECT_REQUIRED_OPTIONS = [
  "add",
  "remove",
  "dev",
  "build",
  "deploy",
  "status",
  "invoke",
  "log",
  "traces",
  "export",
];
const NO_PROJECT_HIDDEN_OPTIONS = [...PROJECT_REQUIRED_OPTIONS];

export interface RootScreenProps extends ScreenProps {
  inProject?: boolean;
}

export function RootScreen({ inProject, ...props }: RootScreenProps) {
  const projectDetected = useProjectDetected(props.core, inProject);
  const updateState = useTuiUpdate();
  if (projectDetected.data === undefined) {
    const command = resolveCommand(props.ctx.require(CommandKey), ["agentcore"]);
    return (
      <LoadingFrame
        breadcrumb={["agentcore"]}
        description={command.description()}
        query={projectDetected}
        loadingLabel="checking for a project…"
      />
    );
  }

  return (
    <RouterScreen
      {...props}
      banner={<BrandBanner />}
      path={["agentcore"]}
      optionHints={projectDetected.data ? undefined : NO_PROJECT_HINTS}
      cliSectionCommands={ROOT_CLI_SECTION_COMMANDS}
      optionNotices={
        updateState.updateAvailable
          ? { update: `· update to install ${updateState.latestVersion}` }
          : undefined
      }
      alert={projectDetected.data ? undefined : NO_PROJECT_ALERT}
      hiddenOptions={projectDetected.data ? PROJECT_HIDDEN_OPTIONS : NO_PROJECT_HIDDEN_OPTIONS}
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
