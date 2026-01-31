import { findConfigRoot } from '../../../../lib';
import {
  Cursor,
  ScreenLayout,
  ShellCommandText,
  ShellEscapeContainer,
  ShellPrompt,
  useShellContext,
} from '../../components';
import { buildLogo, useLayout } from '../../context';
import { HINTS, QUICK_START } from '../../copy';
import { Box, Text, useApp, useInput } from 'ink';
import React from 'react';

function InputLine() {
  const { isActive } = useShellContext();

  return (
    <Box>
      <ShellPrompt />
      {isActive ? <ShellCommandText /> : <Cursor />}
    </Box>
  );
}

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

interface HomeContentProps {
  cwd: string;
  version: string;
  onShowHelp: (initialQuery?: string) => void;
  onSelectCreate: () => void;
}

function hasProject(): boolean {
  return findConfigRoot() !== null;
}

// Quick start takes 8 lines: margin(1) + header(1) + margin(1) + 3 items + margin(1) + tip(1)
const QUICK_START_LINES = 8;

function HomeContent({ cwd: _cwd, version, onShowHelp, onSelectCreate }: HomeContentProps) {
  const { exit } = useApp();
  const { isActive } = useShellContext();
  const { contentWidth } = useLayout();
  const showQuickStart = !isActive && !hasProject();
  const logo = buildLogo(contentWidth, version);
  const divider = '─'.repeat(contentWidth);

  useInput((input, key) => {
    if (isActive) return;

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

    if (input === '!') return;

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
          <InputLine />
        </Box>

        {/* Quick Start or equal blank space */}
        {showQuickStart ? <QuickStart /> : !isActive && <Box height={QUICK_START_LINES} />}

        {/* Divider and hint at bottom */}
        {!isActive && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>{divider}</Text>
            <Text dimColor>{HINTS.HOME}</Text>
          </Box>
        )}
      </Box>
    </ScreenLayout>
  );
}

// Reserved: logo(4) + version(1) + input margin(1) + input(1) + indicator(1) + padding(2) + buffer(2)
const RESERVED_LINES = 12;

interface HomeScreenProps {
  cwd: string;
  version: string;
  initialShellCommand?: string;
  onShowHelp: (initialQuery?: string) => void;
  onSelectCreate: () => void;
  /** Called when shell mode completes (after running a command). Used to auto-return to previous screen. */
  onShellComplete?: () => void;
}

export function HomeScreen({
  cwd,
  version,
  initialShellCommand,
  onShowHelp,
  onSelectCreate,
  onShellComplete,
}: HomeScreenProps) {
  return (
    <ShellEscapeContainer
      reservedLines={RESERVED_LINES}
      initialShellCommand={initialShellCommand}
      onShellComplete={onShellComplete}
    >
      <HomeContent cwd={cwd} version={version} onShowHelp={onShowHelp} onSelectCreate={onSelectCreate} />
    </ShellEscapeContainer>
  );
}
