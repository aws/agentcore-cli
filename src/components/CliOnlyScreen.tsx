import { useRef } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import type { Command } from "commander";
import { useLocation, useNavigate } from "react-router";
import { CommandKey, commandParameterDetails } from "../router";
import type { ScreenProps } from "../handlers/types";
import { Layout } from "./Layout";
import { KeyValueTable } from "./KeyValueTable";
import { RouterScreen, resolveCommand } from "./RouterScreen";
import { darkTheme } from "./ui/_core.js";

const theme = darkTheme;

export interface CliOnlyScreenProps extends ScreenProps {
  // path is the command's path, e.g. ["agentcore", "project", "dev"].
  path: string[];
}

// CliOnlyScreen stands in for a command that has no screen of its own: it says
// so, and shows the command's help — usage, arguments, options, parameter
// details — from the same Commander help `--help` prints, so the two cannot
// differ. The body scrolls; esc returns to the parent menu.
export function CliOnlyScreen({ ctx, path }: CliOnlyScreenProps) {
  const navigate = useNavigate();
  const scroll = useRef<ScrollViewRef>(null);
  // Subscribing to the window size re-renders this screen on a resize. Layout
  // re-renders on its own, but its children are the same elements, so without
  // this the ScrollView is never re-rendered, never re-measures, and never
  // reports the size change the clamp below responds to.
  useWindowSize();
  const command = resolveCommand(ctx.require(CommandKey), path);
  const help = command.createHelp();

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

  const table = (rows: [string, string][]) => Object.fromEntries(rows);
  // --help is Commander's own and means nothing on a screen that is the help.
  const options = table(
    help
      .visibleOptions(command)
      .filter((option) => option.long !== "--help")
      .map((option) => [help.optionTerm(option), help.optionDescription(option)]),
  );
  const args = table(
    help
      .visibleArguments(command)
      .map((argument) => [help.argumentTerm(argument), help.argumentDescription(argument)]),
  );
  const details = commandParameterDetails(command);

  return (
    <Layout
      breadcrumb={path}
      description={help.commandDescription(command)}
      keyHints={[
        { key: "↑↓", label: "scroll" },
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
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
          <Text color={theme.colors.muted}>this command runs from the command line</Text>
          <Text> </Text>
          <Text color={theme.colors.primary}>{`  ${help.commandUsage(command)}`}</Text>
          {Object.keys(args).length > 0 && (
            <Section title="arguments">
              <KeyValueTable items={args} />
            </Section>
          )}
          {Object.keys(options).length > 0 && (
            <Section title="options">
              <KeyValueTable items={options} />
            </Section>
          )}
          {details !== undefined && (
            // formatParameterDetails already carries its own heading and layout.
            <Text color={theme.colors.muted}>{details.trim()}</Text>
          )}
        </ScrollView>
      </Box>
    </Layout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.colors.text}>{title}</Text>
      <Box paddingLeft={2}>{children}</Box>
    </Box>
  );
}

// CommandFallbackScreen is the route for any command path Root does not map to
// a screen of its own: a command group renders its menu, a leaf renders its
// help. `basePath` is the route prefix the wildcard matched under.
export function CommandFallbackScreen({
  basePath,
  ...props
}: ScreenProps & { basePath: string[] }) {
  const { pathname } = useLocation();
  const path = pathname.split("/").filter((segment) => segment !== "");
  const command = resolveCommand(props.ctx.require(CommandKey), path);
  // An unknown trailing segment resolves to the nearest ancestor; show that.
  const resolved = commandPath(command);
  if (resolved.length < basePath.length) {
    return <RouterScreen {...props} path={basePath} showCliOnly />;
  }
  return command.commands.length > 0 ? (
    <RouterScreen {...props} path={resolved} showCliOnly />
  ) : (
    <CliOnlyScreen {...props} path={resolved} />
  );
}

function commandPath(command: Command): string[] {
  const names: string[] = [];
  for (let cur: Command | null = command; cur; cur = cur.parent) names.unshift(cur.name());
  return names;
}
