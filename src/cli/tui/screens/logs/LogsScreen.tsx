import { FullScreenLogView, LogPanel, Screen, SelectList } from '../../components';
import type { LogEntry } from '../../components/LogPanel';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks/useListNavigation';
import { useLogsFlow } from './useLogsFlow';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useMemo, useState } from 'react';

interface LogsScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type LevelFilter = 'all' | 'error' | 'warn';

const FILTER_LABELS: Record<LevelFilter, string> = {
  all: 'All',
  error: 'Errors',
  warn: 'Warn+Errors',
};

function filterLogs(logs: LogEntry[], filter: LevelFilter): LogEntry[] {
  if (filter === 'all') return logs;
  if (filter === 'error') return logs.filter(l => l.level === 'error');
  if (filter === 'warn') return logs.filter(l => l.level === 'error' || l.level === 'warn');
  return logs;
}

export function LogsScreen({ onExit }: LogsScreenProps) {
  const { phase, agents, selectedAgent, loadError, selectAgent, logs, isStreaming, streamError } = useLogsFlow();
  const [showFullScreen, setShowFullScreen] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const maxLines = Math.max(5, terminalHeight - 14);

  const filteredLogs = useMemo(() => filterLogs(logs, levelFilter), [logs, levelFilter]);

  const { selectedIndex } = useListNavigation({
    items: agents,
    onSelect: agent => selectAgent(agent),
    onExit,
    isActive: phase === 'select-agent' && !showFullScreen,
  });

  useInput(
    (input, _key) => {
      if (phase === 'streaming' && !showFullScreen) {
        if (input === 'f') {
          setShowFullScreen(true);
        }
        if (input === '1') {
          setLevelFilter('all');
        }
        if (input === '2') {
          setLevelFilter('error');
        }
        if (input === '3') {
          setLevelFilter('warn');
        }
      }
    },
    { isActive: phase === 'streaming' && !showFullScreen }
  );

  if (showFullScreen) {
    return <FullScreenLogView logs={filteredLogs} onExit={() => setShowFullScreen(false)} />;
  }

  if (phase === 'loading') {
    return (
      <Screen title="Logs" onExit={onExit} helpText="Loading...">
        <Text>Loading deployed agents...</Text>
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen title="Logs" onExit={onExit} helpText={HELP_TEXT.BACK}>
        <Text color="red">{loadError}</Text>
      </Screen>
    );
  }

  if (phase === 'select-agent') {
    const items = agents.map(a => ({
      id: a.agentId,
      title: a.agentName,
      description: `${a.region}`,
    }));

    return (
      <Screen title="Logs" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Box flexDirection="column">
          <Text bold>Select an agent to stream logs:</Text>
          <Box marginTop={1}>
            <SelectList items={items} selectedIndex={selectedIndex} />
          </Box>
        </Box>
      </Screen>
    );
  }

  return (
    <Screen
      title="Logs"
      onExit={onExit}
      helpText="f full-screen · 1 all · 2 errors · 3 warn+ · Esc back"
      exitEnabled={!showFullScreen}
      headerContent={
        <Box flexDirection="column">
          <Box>
            <Text>Agent: </Text>
            <Text color="green">{selectedAgent?.agentName}</Text>
            <Text> Region: </Text>
            <Text color="cyan">{selectedAgent?.region}</Text>
            <Text> Filter: </Text>
            <Text bold>{FILTER_LABELS[levelFilter]}</Text>
            <Text dimColor>
              {' '}
              ({filteredLogs.length}/{logs.length})
            </Text>
          </Box>
          <Box>
            <Text>Status: </Text>
            {isStreaming ? (
              <Text color="green">Streaming...</Text>
            ) : streamError ? (
              <Text color="red">Error</Text>
            ) : (
              <Text color="yellow">Disconnected</Text>
            )}
          </Box>
          {streamError && <Text color="red">{streamError}</Text>}
        </Box>
      }
    >
      <Box flexDirection="column" height={maxLines + 2} overflow="hidden">
        <LogPanel logs={filteredLogs} maxLines={maxLines} minimal={false} isActive={phase === 'streaming'} />
      </Box>
    </Screen>
  );
}
