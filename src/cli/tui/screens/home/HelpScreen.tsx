import { Cursor, ScreenLayout } from '../../components';
import { useLayout } from '../../context';
import { HINTS } from '../../copy';
import { useTextInput } from '../../hooks';
import type { CommandMeta } from '../../utils/commands';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

function truncateDescription(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen - 1) + '…';
}

interface DisplayItem {
  command: CommandMeta;
  matchedSubcommand?: string;
}

interface HelpDisplayProps {
  interactiveItems: DisplayItem[];
  cliOnlyItems: DisplayItem[];
  showCliOnly: boolean;
  query: string;
  cursor: number;
  clampedIndex: number;
  interactiveCount: number;
  notice?: React.ReactNode;
}

function CommandRow({
  item,
  selected,
  maxLabelLen,
  maxDescWidth,
}: {
  item: DisplayItem;
  selected: boolean;
  maxLabelLen: number;
  maxDescWidth: number;
}) {
  const desc = truncateDescription(item.command.description, maxDescWidth);
  const labelLen = item.matchedSubcommand
    ? item.command.title.length + 3 + item.matchedSubcommand.length
    : item.command.title.length;
  const padding = ' '.repeat(Math.max(1, maxLabelLen - labelLen + 2));
  const itemKey = item.matchedSubcommand ? `${item.command.id}-${item.matchedSubcommand}` : item.command.id;

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
      <Text>{padding}</Text>
      <Text dimColor>{desc}</Text>
    </Box>
  );
}

function getMaxLabelLen(items: DisplayItem[]): number {
  if (items.length === 0) return 0;
  return Math.max(
    ...items.map(item =>
      item.matchedSubcommand ? item.command.title.length + 3 + item.matchedSubcommand.length : item.command.title.length
    )
  );
}

function HelpDisplay({
  interactiveItems,
  cliOnlyItems,
  showCliOnly,
  query,
  cursor,
  clampedIndex,
  interactiveCount,
  notice,
}: HelpDisplayProps) {
  const { contentWidth } = useLayout();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const bottomDivider = '─'.repeat(contentWidth);

  const allItems = [...interactiveItems, ...cliOnlyItems];
  const maxLabelLen = getMaxLabelLen(allItems);
  const maxDescWidth = Math.max(20, terminalWidth - maxLabelLen - 8);

  const hasCliOnly = cliOnlyItems.length > 0;
  const showCliSection = hasCliOnly && (showCliOnly || !!query);

  const hintText = showCliOnly ? HINTS.COMMANDS_HIDE_CLI : HINTS.COMMANDS_SHOW_ALL;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Commands
      </Text>

      <Box marginTop={1} flexShrink={0}>
        <Text color="cyan">&gt; </Text>
        <Text>{query.slice(0, cursor)}</Text>
        <Cursor />
        <Text>{query.slice(cursor)}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {allItems.length === 0 && !showCliSection ? (
          <Box flexDirection="column">
            <Text dimColor>No commands match &quot;{query}&quot;</Text>
            <Text dimColor>Esc to clear</Text>
          </Box>
        ) : (
          <>
            {interactiveItems.map((item, idx) => (
              <CommandRow
                key={item.matchedSubcommand ? `${item.command.id}-${item.matchedSubcommand}` : item.command.id}
                item={item}
                selected={idx === clampedIndex}
                maxLabelLen={maxLabelLen}
                maxDescWidth={maxDescWidth}
              />
            ))}

            {showCliSection && (
              <>
                <Box marginTop={1}>
                  <Text dimColor>CLI only {'─'.repeat(Math.max(0, contentWidth - 11))}</Text>
                </Box>
                {cliOnlyItems.map((item, idx) => (
                  <CommandRow
                    key={item.matchedSubcommand ? `${item.command.id}-${item.matchedSubcommand}` : item.command.id}
                    item={item}
                    selected={interactiveCount + idx === clampedIndex}
                    maxLabelLen={maxLabelLen}
                    maxDescWidth={maxDescWidth}
                  />
                ))}
              </>
            )}
          </>
        )}
      </Box>

      {notice && <Box marginTop={1}>{notice}</Box>}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{bottomDivider}</Text>
        <Text dimColor>{hintText}</Text>
      </Box>
    </Box>
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
  const { commands, initialQuery, notice, onNoticeDismiss, onSelect, onBack } = props;
  const [index, setIndex] = useState(0);
  const [showCliOnly, setShowCliOnly] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const confirmTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (confirmExit) {
      confirmTimeoutRef.current = setTimeout(() => {
        setConfirmExit(false);
      }, 3000);
    }
    return () => {
      if (confirmTimeoutRef.current) {
        clearTimeout(confirmTimeoutRef.current);
      }
    };
  }, [confirmExit]);

  const {
    value: query,
    cursor,
    clear,
  } = useTextInput({
    initialValue: initialQuery ?? '',
    isActive: true,
    excludeChars: ['/'],
  });

  function filterCommand(cmd: CommandMeta): DisplayItem[] {
    if (cmd.disabled) return [];
    if (!query) return [{ command: cmd }];

    const q = query.toLowerCase();
    const matchesCommand = cmd.id.toLowerCase().includes(q);
    const matchingSubcommands = cmd.subcommands.filter(sub => sub.toLowerCase().includes(q));

    const results: DisplayItem[] = [];
    if (matchesCommand) {
      results.push({ command: cmd });
    }
    for (const sub of matchingSubcommands) {
      if (!matchesCommand) {
        results.push({ command: cmd, matchedSubcommand: sub });
      }
    }
    return results;
  }

  const interactiveItems = useMemo((): DisplayItem[] => {
    return commands.filter(cmd => !cmd.cliOnly).flatMap(filterCommand);
  }, [commands, query]);

  const cliOnlyItems = useMemo((): DisplayItem[] => {
    return commands.filter(cmd => cmd.cliOnly).flatMap(filterCommand);
  }, [commands, query]);

  const visibleCliOnlyItems = query ? cliOnlyItems : showCliOnly ? cliOnlyItems : [];

  const totalItems = interactiveItems.length + visibleCliOnlyItems.length;

  const clampedIndex = Math.min(index, Math.max(0, totalItems - 1));

  useInput((input, key) => {
    if (notice && onNoticeDismiss) {
      onNoticeDismiss();
    }

    if (input === '/') {
      setShowCliOnly(prev => !prev);
      return;
    }

    if (key.escape) {
      if (query) {
        clear();
        setIndex(0);
        setConfirmExit(false);
      } else if (confirmExit) {
        onBack();
      } else {
        setConfirmExit(true);
      }
      return;
    }

    if (confirmExit) {
      setConfirmExit(false);
    }

    if (key.upArrow && totalItems > 0) {
      setIndex(i => (i - 1 + totalItems) % totalItems);
      return;
    }
    if (key.downArrow && totalItems > 0) {
      setIndex(i => (i + 1) % totalItems);
      return;
    }

    if (key.return && totalItems > 0) {
      const allSelectableItems = [...interactiveItems, ...visibleCliOnlyItems];
      const selectedItem = allSelectableItems.at(clampedIndex);
      if (selectedItem) {
        onSelect(selectedItem.command.id);
      }
      return;
    }
  });

  return (
    <ScreenLayout>
      <HelpDisplay
        interactiveItems={interactiveItems}
        cliOnlyItems={visibleCliOnlyItems}
        showCliOnly={showCliOnly}
        query={query}
        cursor={cursor}
        clampedIndex={clampedIndex}
        interactiveCount={interactiveItems.length}
        notice={confirmExit ? <Text color="yellow">Press Esc again to exit</Text> : notice}
      />
    </ScreenLayout>
  );
}
