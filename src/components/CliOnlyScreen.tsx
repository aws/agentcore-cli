import { useRef, type ReactNode } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useLocation, useNavigate } from "react-router";
import { CommandKey, commandParameterDetails } from "../router";
import type { ScreenProps } from "../handlers/types";
import { Layout } from "./Layout";
import { KeyValueTable } from "./KeyValueTable";
import { RouterScreen, commandPath, resolveCommand } from "./RouterScreen";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface CliOnlyScreenProps extends ScreenProps {
  // path is the command's path, e.g. ["agentcore", "dev"].
  path: string[];
}

interface CommandInfoScreenProps {
  path: string[];
  description?: string;
  children: ReactNode;
}

// CommandInfoScreen is the shared scrollable shell for informational command
// pages. CliOnlyScreen fills it with Commander help; project-only create
// guidance uses the same navigation, layout, and scrolling behavior.
export function CommandInfoScreen({ path, description, children }: CommandInfoScreenProps) {
  const navigate = useNavigate();
  const scroll = useRef<ScrollViewRef>(null);
  // Subscribing to the window size re-renders this screen on a resize. Layout
  // re-renders on its own, but its children are the same elements, so without
  // this the ScrollView is never re-rendered, never re-measures, and never
  // reports the size change the clamp below responds to.
  useWindowSize();

  // ScrollView's scrollBy clamps to the content height, not to the last full
  // page, so this stops at the bottom rather than scrolling the text off. It
  // also runs with no delta when the viewport or content changes size, so an
  // offset that was the bottom of a small terminal is pulled back once the
  // terminal grows. Those callbacks fire before the ScrollView stores the new
  // size, so they pass it in; the ref's own getters would report the old one.
  const scrollBy = (delta = 0, size: { viewport?: number; content?: number } = {}) => {
    const view = scroll.current;
    if (!view) return;
    const viewport = size.viewport ?? view.getViewportHeight();
    const content = size.content ?? view.getContentHeight();
    const bottom = Math.max(0, content - viewport);
    view.scrollTo(Math.max(0, Math.min(view.getScrollOffset() + delta, bottom)));
  };

  useInput((input, key) => {
    if (key.escape) navigate("/" + path.slice(0, -1).join("/"));
    else if (key.upArrow || input === "k") scrollBy(-1);
    else if (key.downArrow || input === "j") scrollBy(1);
    else if (key.pageUp) scrollBy(-(scroll.current?.getViewportHeight() ?? 0));
    else if (key.pageDown) scrollBy(scroll.current?.getViewportHeight() ?? 0);
  });

  return (
    <Layout
      breadcrumb={path}
      description={description}
      keyHints={[
        { key: "↑↓", label: "scroll" },
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column" paddingX={1} flexGrow={1} minHeight={0}>
        <ScrollView
          ref={scroll}
          flexGrow={1}
          minHeight={0}
          onViewportSizeChange={({ height }) => scrollBy(0, { viewport: height })}
          onContentHeightChange={(height) => scrollBy(0, { content: height })}
        >
          {children}
        </ScrollView>
      </Box>
    </Layout>
  );
}

// CliOnlyScreen stands in for a command that has no screen of its own: it says
// so, and shows the command's help — usage, arguments, options, parameter
// details — from the same Commander help `--help` prints, so the two cannot
// differ. The body scrolls; esc returns to the parent menu.
export function CliOnlyScreen({ ctx, path }: CliOnlyScreenProps) {
  const command = resolveCommand(ctx.require(CommandKey), path);
  const help = command.createHelp();

  // --help is Commander's own and means nothing on a screen that is the help.
  const optionGroups: [string, [string, string][]][] = [];
  for (const option of help.visibleOptions(command)) {
    if (option.long === "--help") continue;
    const title = sectionTitle(option.helpGroupHeading);
    const row: [string, string] = [help.optionTerm(option), help.optionDescription(option)];
    const group = optionGroups.find(([existing]) => existing === title);
    if (group) group[1].push(row);
    else optionGroups.push([title, [row]]);
  }
  const args = help
    .visibleArguments(command)
    .map((argument) => [help.argumentTerm(argument), help.argumentDescription(argument)] as const);
  const details = commandParameterDetails(command);

  return (
    <CommandInfoScreen path={path} description={help.commandDescription(command)}>
      <Text color={theme.colors.muted}>this command runs from the command line</Text>
      <Text> </Text>
      <Text color={theme.colors.primary}>{`  ${help.commandUsage(command)}`}</Text>
      <KeyValueTable
        sections={[
          { title: "arguments", rows: args },
          ...optionGroups.map(([title, rows]) => ({ title, rows })),
        ]}
      />
      {details !== undefined && (
        // formatParameterDetails already carries its own heading and layout.
        <Text color={theme.colors.muted}>{details.trim()}</Text>
      )}
    </CommandInfoScreen>
  );
}

const sectionTitle = (group: string | undefined) =>
  group ? group.replace(/:$/, "").toLowerCase() : "options";

// CommandFallbackScreen is the route for any command path Root does not map to
// a screen of its own: a command group renders its menu, a leaf renders its
// interactive help. A path that is not an exact command keeps the original
// HelpScreen fallback.
export function CommandFallbackScreen({
  unknownFallback,
  ...props
}: ScreenProps & { unknownFallback: ReactNode }) {
  const { pathname } = useLocation();
  const path = pathname.split("/").filter((segment) => segment !== "");
  const command = resolveCommand(props.ctx.require(CommandKey), path);
  const resolved = commandPath(command);
  const isExactCommand =
    resolved.length === path.length && resolved.every((segment, index) => segment === path[index]);

  if (!isExactCommand) return unknownFallback;

  return command.commands.length > 0 ? (
    <RouterScreen {...props} path={resolved} />
  ) : (
    <CliOnlyScreen {...props} path={resolved} />
  );
}
