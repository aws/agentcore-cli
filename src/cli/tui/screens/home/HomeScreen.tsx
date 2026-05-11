import { findConfigRoot } from '../../../../lib';
import { Cursor, ScreenLayout } from '../../components';
import { HINTS } from '../../copy';
import { Box, Text, useApp, useInput } from 'ink';
import React from 'react';

function NoProjectMessage() {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="yellow">No AgentCore project found in this directory.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>You can:</Text>
        <Box marginLeft={2} flexDirection="column">
          <Text>
            <Text color="cyan">create</Text>
            <Text dimColor> - Create a new AgentCore project here</Text>
          </Text>
          <Text dimColor>or cd into an existing project directory</Text>
        </Box>
      </Box>
    </Box>
  );
}

function QuickStart() {
  return (
    <Box marginTop={1} flexDirection="column">
      <NoProjectMessage />
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">⚑ </Text>
          <Text dimColor>Press Enter to create a new project</Text>
        </Text>
      </Box>
    </Box>
  );
}

function hasProject(): boolean {
  return findConfigRoot() !== null;
}

// Quick start takes 9 lines for the "no project" message plus tip
const QUICK_START_LINES = 9;

interface HomeScreenProps {
  cwd: string;
  version: string;
  onShowHelp: (initialQuery?: string) => void;
  onSelectCreate: () => void;
}

export function HomeScreen({ cwd: _cwd, version, onShowHelp, onSelectCreate }: HomeScreenProps) {
  const { exit } = useApp();
  const showQuickStart = !hasProject();

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
        {/* Logo with version */}
        <Box borderStyle="single" borderColor="cyan" width="100%" justifyContent="space-between" paddingX={1}>
          <Text color="cyan">{'>_ AgentCore'}</Text>
          {version && <Text color="cyan">v{version}</Text>}
        </Box>

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
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
        >
          <Text dimColor>{HINTS.HOME}</Text>
        </Box>
      </Box>
    </ScreenLayout>
  );
}
