import { findConfigRoot } from '../../../../lib';
import { Cursor, ScreenLayout } from '../../components';
import { buildLogo, useLayout } from '../../context';
import { HINTS, QUICK_START } from '../../copy';
import { Box, Text, useApp, useInput } from 'ink';
import React from 'react';

function QuickStart() {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color="cyan">
        Quick Start
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">create</Text>
          <Text dimColor> {QUICK_START.create}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">⚑ </Text>
          <Text dimColor>Run create to get started</Text>
        </Text>
      </Box>
    </Box>
  );
}

function hasProject(): boolean {
  return findConfigRoot() !== null;
}

// Quick start takes 8 lines: margin(1) + header(1) + margin(1) + 3 items + margin(1) + tip(1)
const QUICK_START_LINES = 8;

interface HomeScreenProps {
  cwd: string;
  version: string;
  onShowHelp: (initialQuery?: string) => void;
  onSelectCreate: () => void;
}

export function HomeScreen({ cwd: _cwd, version, onShowHelp, onSelectCreate }: HomeScreenProps) {
  const { exit } = useApp();
  const { contentWidth } = useLayout();
  const showQuickStart = !hasProject();
  const logo = buildLogo(contentWidth, version);
  const divider = '─'.repeat(contentWidth);

  useInput((input, key) => {
    if (key.escape) {
      exit();
      return;
    }

    if (key.return && showQuickStart) {
      onSelectCreate();
      return;
    }

    if (key.tab) {
      onShowHelp();
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      onShowHelp(input);
    }
  });

  return (
    <ScreenLayout>
      <Box flexDirection="column">
        {/* Logo with version - always at top */}
        <Text color="cyan">{logo}</Text>

        {/* Input - directly under logo */}
        <Box marginTop={1}>
          <Box>
            <Text color="cyan">&gt; </Text>
            <Cursor />
          </Box>
        </Box>

        {/* Quick Start or equal blank space */}
        {showQuickStart ? <QuickStart /> : <Box height={QUICK_START_LINES} />}

        {/* Divider and hint at bottom */}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{divider}</Text>
          <Text dimColor>{HINTS.HOME}</Text>
        </Box>
      </Box>
    </ScreenLayout>
  );
}
