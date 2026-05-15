import type { AgentContext } from '../../../commands/logs/action';
import { resolveAgentContext } from '../../../commands/logs/action';
import { loadDeployedProjectConfig } from '../../../operations/resolve-agent';
import { FullScreenLogView, Screen, SelectList } from '../../components';
import { useLogsStream } from '../../hooks/useLogsStream';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

interface LogsScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'loading' | 'select-agent' | 'streaming' | 'error';

export function LogsScreen({ onExit }: LogsScreenProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [agents, setAgents] = useState<AgentContext[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<AgentContext | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [showFullScreen, setShowFullScreen] = useState(false);

  const { logs, isStreaming, error: streamError } = useLogsStream(selectedAgent);

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
        if (input === 'l') {
          setShowFullScreen(true);
        }
      }
    },
    { isActive: !showFullScreen }
  );

  if (showFullScreen) {
    return <FullScreenLogView logs={logs} onExit={() => setShowFullScreen(false)} />;
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

  const helpText = isStreaming
    ? '↑↓ scroll · l full-screen · Esc back'
    : streamError
      ? 'Esc back'
      : '↑↓ scroll · l full-screen · Esc back';

  return (
    <Screen
      title="Logs"
      onExit={onExit}
      helpText={helpText}
      headerContent={
        <Box flexDirection="column">
          <Box>
            <Text>Agent: </Text>
            <Text color="green">{selectedAgent?.agentName}</Text>
          </Box>
          <Box>
            <Text>Region: </Text>
            <Text color="cyan">{selectedAgent?.region}</Text>
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
          {streamError && (
            <Box marginTop={1}>
              <Text color="red">{streamError}</Text>
            </Box>
          )}
        </Box>
      }
    >
      <Box flexDirection="column" flexGrow={1}>
        {logs.length === 0 && isStreaming && <Text dimColor>Waiting for logs...</Text>}
        {logs.length > 0 && (
          <Box flexDirection="column">
            {logs.slice(-20).map((log, idx) => (
              <Text key={idx} color={log.level === 'error' ? 'red' : log.level === 'warn' ? 'yellow' : undefined}>
                {log.message}
              </Text>
            ))}
            {logs.length > 20 && (
              <Text dimColor>Showing last 20 of {logs.length} entries. Press l for full-screen view.</Text>
            )}
          </Box>
        )}
      </Box>
    </Screen>
  );
}
