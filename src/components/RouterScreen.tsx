import React, { useContext, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { Command } from "commander";
import { Navigate, useNavigate } from "react-router";
import {
  CommandKey,
  commandMenuSectionStart,
  isListedInMenu,
  isTuiCommandSupported,
} from "../router";
import {
  BRAND_BANNER_ROWS,
  MIN_BANNER_COLUMNS,
  MIN_BANNER_ROWS,
  shouldHideBrandBanner,
} from "./BrandBanner";
import { Layout } from "./Layout";
import { Divider } from "./ui/divider";
import { TextInput } from "./ui/text-input";
import { darkTheme, glyphs } from "./ui/_core.js";
import type { ScreenProps } from "../handlers/types";
import { RegionPinContext } from "../handlers/utils";
import { scrollWindow } from "./scrollWindow";

const theme = darkTheme;
const PLACEHOLDER = "type to choose a command";
const CLI_ONLY_SECTION = "cli";
const FILTER_ROWS = 2;

// rootCommand walks up to the top of the Commander tree.
function rootCommand(c: Command): Command {
  let cur = c;
  while (cur.parent) cur = cur.parent;
  return cur;
}

// resolveCommand finds the Command for a screen's `path` (e.g.
// ["agentcore", "harness"]). Navigating between TUI screens never re-runs a
// handler, so `CommandKey` is pinned to whichever command *launched* the TUI —
// we walk up to the root and back down the path to recover the screen's own
// command regardless of where the app started.
export function resolveCommand(launch: Command, path: string[]): Command {
  let cur = rootCommand(launch);
  for (let i = 1; i < path.length; i++) {
    const next = cur.commands.find((c) => c.name() === path[i]);
    if (!next) break;
    cur = next;
  }
  return cur;
}

export function commandPath(command: Command): string[] {
  const names: string[] = [];
  for (let cur: Command | null = command; cur; cur = cur.parent) names.unshift(cur.name());
  return names;
}

interface Option {
  name: string;
  description: string;
  // cliOnly marks a subcommand without a screen; it is listed under a divider
  // and opens its help instead.
  cliOnly: boolean;
  // section is the divider title this option is listed under, if any.
  section?: string;
}

export interface TuiOnlyCommand {
  name: string;
  description: string;
}

export interface RouterScreenProps extends ScreenProps {
  // banner is content shown above the standard screen header.
  banner?: React.ReactNode;
  // path is the screen's command path, e.g. ["agentcore", "harness"]. The first
  // segment is the app root; the last is the command whose subcommands are the
  // menu options.
  path: string[];
  // tuiOnlyCommands are navigable informational flows that intentionally do
  // not exist in the CLI command tree.
  tuiOnlyCommands?: TuiOnlyCommand[];
}

// RouterScreen renders the interactive command menu for a Router node: a filter
// input at the top and the node's subcommands (read straight off the Commander
// Command) as navigable options below. Selecting an option routes to that
// subcommand's screen. Subcommands without a screen are listed below a divider
// and open their help instead (see CliOnlyScreen).
export function RouterScreen(props: RouterScreenProps) {
  const command = resolveCommand(props.ctx.require(CommandKey), props.path);
  const resolvedPath = commandPath(command);
  // Project views reuse resource screens, but disabled command menus do not exist.
  if (resolvedPath.join("/") !== props.path.join("/")) {
    return <Navigate to={"/" + resolvedPath.join("/")} replace />;
  }
  return <CommandMenu {...props} command={command} />;
}

function CommandMenu({
  banner,
  path,
  tuiOnlyCommands = [],
  command,
}: RouterScreenProps & { command: Command }) {
  const navigate = useNavigate();
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();

  // A menu is not about any one resource: whatever is opened from it fetches
  // in the launch region again.
  const pinRegion = useContext(RegionPinContext);
  useEffect(() => {
    pinRegion(undefined);
  }, [pinRegion]);

  // Commands in registration order, then the command-line-only ones under their
  // own divider. A section the router declared with menuSection covers the
  // commands from where it was declared up to the next one. A command the
  // router listed with listInMenu stays in place, styled like one with a
  // screen; selecting it still opens its help.
  const options: Option[] = useMemo(() => {
    // Each command's section is the nearest divider declared at or above it.
    const sectionOf = (index: number) =>
      command.commands
        .slice(0, index + 1)
        .map(commandMenuSectionStart)
        .findLast((title) => title !== undefined);
    const actual: Option[] = command.commands.map((c, index) => {
      const cliOnly = !isTuiCommandSupported(c) && !isListedInMenu(c);
      return {
        name: c.name(),
        description: c.description(),
        cliOnly,
        section: cliOnly ? CLI_ONLY_SECTION : sectionOf(index),
      };
    });
    const actualNames = new Set(actual.map((option) => option.name));
    const tuiOnly = tuiOnlyCommands
      .filter((option) => !actualNames.has(option.name))
      .map((option) => ({ ...option, cliOnly: false }));
    return [
      ...tuiOnly,
      ...actual.filter((option) => !option.cliOnly),
      ...actual.filter((option) => option.cliOnly),
    ];
  }, [command, tuiOnlyCommands]);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const filtered = useMemo(
    () => options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  );

  // Keep the highlight within the (possibly shrunken) filtered list. The best
  // match is index 0, which is what a fresh query resets to.
  const highlight = Math.min(index, Math.max(0, filtered.length - 1));

  const base = "/" + path.join("/");

  // Width of the name column so descriptions line up (longest name + a gap).
  const nameWidth = options.reduce((m, o) => Math.max(m, o.name.length), 0) + 3;

  // Navigation-only input. Text editing (typing, backspace, cursor) is owned by
  // the TextInput below; this handler just drives list movement, selection, and
  // going back. It coexists with TextInput's own useInput — every keystroke
  // reaches both, so the two must handle disjoint keys.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      if (key.upArrow) {
        // Functional updates so a burst of buffered key events (Ink drains them
        // synchronously) each build on the previous, not a stale render value.
        setIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1));
        return;
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(filtered.length - 1, Math.min(i, filtered.length - 1) + 1));
        return;
      }
      if (key.return) {
        const opt = filtered[highlight];
        if (opt) navigate(`${base}/${opt.name}`);
        return;
      }
      if (key.escape) {
        // Go back to the parent command screen, inferred from this screen's
        // path (e.g. harness -> agentcore). Navigating to an explicit parent
        // rather than popping history avoids cycles when we arrived here via a
        // sibling screen's own back-navigation. At the root there is no parent,
        // so escape is a no-op.
        if (path.length > 1) navigate("/" + path.slice(0, -1).join("/"));
        return;
      }
    },
    { isActive: Boolean(isRawModeSupported) },
  );

  return (
    <Layout
      banner={banner}
      bannerHeight={BRAND_BANNER_ROWS}
      hideBanner={Boolean(banner) && shouldHideBrandBanner(process.env.TERM_PROGRAM)}
      bannerMinColumns={MIN_BANNER_COLUMNS}
      bannerMinRows={MIN_BANNER_ROWS}
      breadcrumb={path}
      description={command.description()}
      keyHints={[
        { key: "type", label: "filter" },
        { key: "↑↓", label: "navigate" },
        { key: "enter", label: "select" },
        // The root has no parent, so esc does nothing there; don't advertise it.
        ...(path.length > 1 ? [{ key: "esc", label: "back" }] : []),
        { key: "ctrl+c", label: "quit" },
      ]}
    >
      {({ columns, contentRows }) => (
        <CommandMenuBody
          columns={columns}
          contentRows={contentRows}
          filtered={filtered}
          highlight={highlight}
          isRawModeSupported={Boolean(isRawModeSupported)}
          nameWidth={nameWidth}
          query={query}
          onQueryChange={(value) => {
            setQuery(value);
            setIndex(0);
          }}
        />
      )}
    </Layout>
  );
}

interface CommandMenuBodyProps {
  columns: number;
  contentRows: number;
  filtered: Option[];
  highlight: number;
  isRawModeSupported: boolean;
  nameWidth: number;
  query: string;
  onQueryChange: (value: string) => void;
}

function CommandMenuBody({
  columns,
  contentRows,
  filtered,
  highlight,
  isRawModeSupported,
  nameWidth,
  query,
  onQueryChange,
}: CommandMenuBodyProps) {
  const sections = useMemo(() => filtered.map((option) => option.section), [filtered]);
  const menuHeight = Math.max(0, contentRows - FILTER_ROWS);
  const windowStart = Math.max(0, highlight - Math.floor(menuHeight / 2));
  const view = scrollWindow({
    sections,
    highlight,
    start: windowStart,
    budget: menuHeight,
  });

  return (
    <Box flexDirection="column" height={contentRows} overflow="hidden">
      <Box paddingX={1} height={1} overflow="hidden" flexShrink={0}>
        <TextInput
          value={query}
          onChange={onQueryChange}
          placeholder={PLACEHOLDER}
          prompt="/ "
          focus={isRawModeSupported}
        />
      </Box>

      <Divider />

      <Box flexDirection="column" height={menuHeight} overflow="hidden">
        {filtered.length === 0 ? (
          <Box paddingX={1} height={1} overflow="hidden">
            <Text color={theme.colors.text}>No matches</Text>
          </Box>
        ) : (
          view.rows.map((row) => {
            if (row.kind === "section") {
              return <Divider key={`section:${row.title}`} title={row.title} />;
            }
            if (row.kind !== "item") {
              return (
                <Box key={row.kind} paddingX={1} height={1} overflow="hidden" flexShrink={0}>
                  <Text color={theme.colors.muted}>
                    {`  ${row.kind === "more-above" ? "↑" : "↓"} ${row.count} more`}
                  </Text>
                </Box>
              );
            }

            const option = filtered[row.index]!;
            const isHighlighted = row.index === highlight;
            return (
              <Box
                key={option.name}
                paddingX={1}
                width={columns}
                height={1}
                overflow="hidden"
                flexShrink={0}
              >
                {/** A description too long for the row is cut and leaves the name in line. **/}
                <Box flexShrink={0}>
                  <Text color={theme.colors.focus}>
                    {isHighlighted ? `${glyphs.pointer} ` : "  "}
                  </Text>
                  <Text
                    bold={isHighlighted}
                    color={
                      isHighlighted
                        ? theme.colors.focus
                        : option.cliOnly
                          ? theme.colors.muted
                          : theme.colors.text
                    }
                  >
                    {option.name.padEnd(nameWidth)}
                  </Text>
                </Box>
                <Text color={theme.colors.muted}>{option.description}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
