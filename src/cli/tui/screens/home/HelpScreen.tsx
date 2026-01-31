import {
  Cursor,
  ScreenLayout,
  ShellCommandText,
  ShellEscapeContainer,
  ShellPrompt,
  useShellContext,
} from '../../components';
import { useLayout } from '../../context';
import { HINTS } from '../../copy';
import { useTextInput } from '../../hooks';
import type { CommandMeta } from '../../utils/commands';
import { Box, Text, useInput } from 'ink';
import React, { useMemo } from 'react';

const MAX_DESC_WIDTH = 50;

function truncateDescription(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen - 1) + '…';
}

interface DisplayItem {
  command: CommandMeta;
  matchedSubcommand?: string;
}

interface HelpDisplayProps {
  items: DisplayItem[];
  query: string;
  cursor: number;
  clampedIndex: number;
  notice?: React.ReactNode;
}

function HelpDisplay({ items, query, cursor, clampedIndex, notice }: HelpDisplayProps) {
  const { isActive } = useShellContext();
  const { contentWidth } = useLayout();
  const divider = '─'.repeat(contentWidth);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text bold color="cyan">
        Commands
      </Text>

      {/* Input line - changes based on shell mode */}
      <Box marginTop={1} flexShrink={0}>
        <ShellPrompt />
        {isActive ? (
          <ShellCommandText />
        ) : (
          <>
            <Text>{query.slice(0, cursor)}</Text>
            <Cursor />
            <Text>{query.slice(cursor)}</Text>
          </>
        )}
      </Box>

      {/* Commands list - only visible when NOT in shell mode */}
      {!isActive && (
        <Box marginTop={1} flexDirection="column">
          {items.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>No commands match &quot;{query}&quot;</Text>
              <Text dimColor>Esc to clear</Text>
            </Box>
          ) : (
            items.map((item, idx) => {
              const selected = idx === clampedIndex;
              const itemKey = item.matchedSubcommand ? `${item.command.id}-${item.matchedSubcommand}` : item.command.id;
              const desc = truncateDescription(item.command.description, MAX_DESC_WIDTH);
              return (
                <Box key={itemKey}>
                  <Text color={selected ? 'cyan' : 'white'}>{selected ? '❯' : ' '} </Text>
                  <Text bold={selected} color={selected ? 'cyan' : undefined}>
                    {item.command.title}
                  </Text>
                  {item.matchedSubcommand && (
                    <>
                      <Text dimColor> → </Text>
                      <Text bold={selected} color={selected ? 'cyan' : undefined}>
                        {item.matchedSubcommand}
                      </Text>
                    </>
                  )}
                  <Text dimColor> {desc}</Text>
                </Box>
              );
            })
          )}
        </Box>
      )}

      {!isActive && notice && <Box marginTop={1}>{notice}</Box>}

      {/* Divider and hints at bottom */}
      {!isActive && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{divider}</Text>
          <Text dimColor>{HINTS.COMMANDS}</Text>
        </Box>
      )}
    </Box>
  );
}

interface HelpContentProps {
  commands: CommandMeta[];
  initialQuery?: string;
  notice?: React.ReactNode;
  onNoticeDismiss?: () => void;
  onSelect: (id: string) => void;
  onBack: () => void;
}

function HelpContent({ commands, initialQuery, notice, onNoticeDismiss, onSelect, onBack }: HelpContentProps) {
  const { isActive } = useShellContext();
  const [index, setIndex] = React.useState(0);

  const {
    value: query,
    cursor,
    clear,
  } = useTextInput({
    initialValue: initialQuery ?? '',
    isActive: !isActive,
  });

  const items = useMemo((): DisplayItem[] => {
    return commands
      .filter(cmd => !cmd.disabled)
      .flatMap(cmd => {
        if (!query) return [{ command: cmd }];

        const q = query.toLowerCase();
        const matchesCommand = cmd.id.toLowerCase().includes(q);
        const matchingSubcommands = cmd.subcommands.filter(sub => sub.toLowerCase().includes(q));

        const results: DisplayItem[] = [];

        // If command name matches, show it without subcommand highlight
        if (matchesCommand) {
          results.push({ command: cmd });
        }

        // If subcommands match, show each as a separate item
        for (const sub of matchingSubcommands) {
          // Don't duplicate if command already matched
          if (!matchesCommand) {
            results.push({ command: cmd, matchedSubcommand: sub });
          }
        }

        return results;
      });
  }, [commands, query]);

  // Clamp index to valid range when items change
  const clampedIndex = Math.min(index, Math.max(0, items.length - 1));

  useInput((input, key) => {
    // When shell mode is active, don't handle normal screen input
    if (isActive) {
      return;
    }

    if (notice && onNoticeDismiss) {
      onNoticeDismiss();
    }

    if (key.escape) {
      if (query) {
        clear();
        setIndex(0);
      } else {
        onBack();
      }
      return;
    }

    if (key.upArrow && items.length > 0) {
      setIndex(i => (i - 1 + items.length) % items.length);
      return;
    }
    if (key.downArrow && items.length > 0) {
      setIndex(i => (i + 1) % items.length);
      return;
    }

    const selectedItem = items.at(clampedIndex);
    if (key.return && selectedItem) {
      onSelect(selectedItem.command.id);
      return;
    }
  });

  return (
    <ScreenLayout>
      <HelpDisplay items={items} query={query} cursor={cursor} clampedIndex={clampedIndex} notice={notice} />
    </ScreenLayout>
  );
}

export function HelpScreen(props: {
  commands: CommandMeta[];
  initialQuery?: string;
  notice?: React.ReactNode;
  onNoticeDismiss?: () => void;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <ShellEscapeContainer>
      <HelpContent
        commands={props.commands}
        initialQuery={props.initialQuery}
        notice={props.notice}
        onNoticeDismiss={props.onNoticeDismiss}
        onSelect={props.onSelect}
        onBack={props.onBack}
      />
    </ShellEscapeContainer>
  );
}
