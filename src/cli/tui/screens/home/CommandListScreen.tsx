import { buildLogo, useLayout } from '../../context';
import type { CommandMeta } from '../../utils/commands';
import { Box, Text, useApp, useStdout } from 'ink';
import React, { useEffect } from 'react';

function truncateDescription(desc: string, maxLen: number): string {
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen - 1) + '…';
}

interface CommandListScreenProps {
  commands: CommandMeta[];
}

/**
 * Static command list display for --help output.
 * Renders commands and exits immediately.
 */
export function CommandListScreen({ commands }: CommandListScreenProps) {
  const { exit } = useApp();
  const { contentWidth } = useLayout();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const maxDescWidth = Math.max(20, terminalWidth - 18);
  const logo = buildLogo(contentWidth);

  // Exit after render
  useEffect(() => {
    const timer = setTimeout(() => exit(), 0);
    return () => clearTimeout(timer);
  }, [exit]);

  const visibleCommands = commands.filter(cmd => !cmd.disabled);

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text>{logo}</Text>
      <Text> </Text>
      <Text bold color="yellow">
        Usage:
      </Text>
      <Text> agentcore [command]</Text>
      <Text> </Text>
      <Text bold color="yellow">
        Commands:
      </Text>
      {visibleCommands.map(cmd => {
        const desc = truncateDescription(cmd.description, maxDescWidth);
        const padding = ' '.repeat(Math.max(1, 14 - cmd.title.length));
        return (
          <Box key={cmd.id}>
            <Text> </Text>
            <Text color="cyan">{cmd.title}</Text>
            <Text>{padding}</Text>
            <Text dimColor>{desc}</Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>Run agentcore [command] --help for command-specific help</Text>
      <Text dimColor>Run agentcore (no args) for interactive mode</Text>
    </Box>
  );
}
