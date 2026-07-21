import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { Command } from "commander";
import { useNavigate } from "react-router";
import { CommandKey } from "../router";
import { Layout } from "./Layout";
import { Divider } from "./ui/divider";
import { TextInput } from "./ui/text-input";
import { darkTheme } from "./ui/_core.js";
import type { ScreenProps } from "../handlers/types";

const theme = darkTheme;
const PLACEHOLDER = "type to choose a command";

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
function resolveCommand(launch: Command, path: string[]): Command {
  let cur = rootCommand(launch);
  for (let i = 1; i < path.length; i++) {
    const next = cur.commands.find((c) => c.name() === path[i]);
    if (!next) break;
    cur = next;
  }
  return cur;
}

interface Option {
  name: string;
  description: string;
}

export interface RouterScreenProps extends ScreenProps {
  // path is the screen's command path, e.g. ["agentcore", "harness"]. The first
  // segment is the app root; the last is the command whose subcommands are the
  // menu options.
  path: string[];
}

// RouterScreen renders the interactive command menu for a Router node: a filter
// input at the top and the node's subcommands (read straight off the Commander
// Command) as navigable options below. Selecting an option routes to that
// subcommand's screen.
export function RouterScreen({ ctx, path }: RouterScreenProps) {
  const navigate = useNavigate();
  const { isRawModeSupported } = useStdin();
  const { exit } = useApp();

  const command = resolveCommand(ctx.require(CommandKey), path);
  const options: Option[] = useMemo(
    () => command.commands.map((c) => ({ name: c.name(), description: c.description() })),
    [command],
  );

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
      breadcrumb={path}
      description={command.description()}
      keyHints={[
        { key: "type", label: "filter" },
        { key: "↑↓", label: "navigate" },
        { key: "enter", label: "select" },
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      <Box flexDirection="column">
        {/* Filter input. TextInput owns text editing; the highlight resets to
            the best match whenever the query changes. */}
        <Box paddingX={1}>
          <TextInput
            value={query}
            onChange={(v) => {
              setQuery(v);
              setIndex(0);
            }}
            placeholder={PLACEHOLDER}
            prompt="/ "
            focus={Boolean(isRawModeSupported)}
          />
        </Box>

        <Divider />

        {/* Options */}
        <Box flexDirection="column">
          {filtered.length === 0 ? (
            <Box paddingX={1}>
              <Text color={theme.colors.text}>No matches</Text>
            </Box>
          ) : (
            filtered.map((o, i) => {
              const isHl = i === highlight;
              return (
                <Box key={o.name} paddingX={1}>
                  <Text color={theme.colors.focus}>{isHl ? "❯ " : "  "}</Text>
                  <Text bold={isHl} color={isHl ? theme.colors.focus : theme.colors.text}>
                    {o.name.padEnd(nameWidth)}
                  </Text>
                  <Text color={theme.colors.muted}>{o.description}</Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </Layout>
  );
}
