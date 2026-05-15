import type { AgentContext } from '../../../commands/logs/action';
import { resolveAgentContext } from '../../../commands/logs/action';
import { loadDeployedProjectConfig } from '../../../operations/resolve-agent';
import { FullScreenLogView, LogPanel, Screen, SelectList } from '../../components';
import type { LogEntry } from '../../components/LogPanel';
import { useLogsStream } from '../../hooks/useLogsStream';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

interface LogsScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'loading' | 'select-agent' | 'streaming' | 'error';
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
  const [phase, setPhase] = useState<Phase>('loading');
  const [agents, setAgents] = useState<AgentContext[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<AgentContext | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [showFullScreen, setShowFullScreen] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const maxLines = Math.max(5, terminalHeight - 14);

  const { logs, isStreaming, error: streamError } = useLogsStream(selectedAgent);

  const filteredLogs = useMemo(() => filterLogs(logs, levelFilter), [logs, levelFilter]);

  useEffect(() => {
    const load = async () => {
      try {
        const context = await loadDeployedProjectConfig();
        const runtimeNames = context.project.runtimes.map(r => r.name);

        if (runtimeNames.length === 0) {
          setLoadError('No runtimes defined in agentcore.json');
          setPhase('error');
          return;
        }

        const resolved: AgentContext[] = [];
        for (const name of runtimeNames) {
          const result = resolveAgentContext(context, { runtime: name });
          if (result.success) {
            resolved.push(result.agentContext);
          }
        }

        if (resolved.length === 0) {
          setLoadError('No deployed agents found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        setAgents(resolved);

        if (resolved.length === 1) {
          setSelectedAgent(resolved[0]);
          setPhase('streaming');
        } else {
          setPhase('select-agent');
        }
      } catch (err) {
        setLoadError((err as Error).message ?? 'Failed to load project config');
        setPhase('error');
      }
    };

    void load();
  }, []);

  useInput(
    (input, key) => {
      if (phase === 'select-agent') {
        if (key.upArrow || input === 'k') {
          setSelectedIndex(prev => (prev - 1 + agents.length) % agents.length);
        }
        if (key.downArrow || input === 'j') {
          setSelectedIndex(prev => (prev + 1) % agents.length);
        }
        if (key.return) {
          const agent = agents[selectedIndex];
          if (agent) {
            setSelectedAgent(agent);
            setPhase('streaming');
          }
        }
      }

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
    { isActive: !showFullScreen }
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
      <Screen title="Logs" onExit={onExit} helpText="Esc back">
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
      <Screen title="Logs" onExit={onExit} helpText="↑↓ select · Enter confirm · Esc back">
        <Box flexDirection="column">
          <Text bold>Select an agent to stream logs:</Text>
          <Box marginTop={1}>
            <SelectList items={items} selectedIndex={selectedIndex} />
          </Box>
        </Box>
      </Screen>
    );
  }

  const helpText = '↑↓ scroll · f full-screen · 1 all · 2 errors · 3 warn+ · Esc back';

  return (
    <Screen
      title="Logs"
      onExit={onExit}
      helpText={helpText}
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
