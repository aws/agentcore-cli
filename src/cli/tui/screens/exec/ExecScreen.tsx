import { ConfigIO } from '../../../../lib';
import { Panel, Screen, SelectList } from '../../components';
import { HELP_TEXT } from '../../constants';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';

interface ExecAgent {
  name: string;
  runtimeArn: string;
  description?: string;
}

interface ExecScreenProps {
  onSelect: (result: { runtimeArn: string; sessionId?: string; autoSelected?: boolean }) => void;
  onExit: () => void;
}

export function ExecScreen({ onSelect, onExit }: ExecScreenProps) {
  const [agents, setAgents] = useState<ExecAgent[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { stdout } = useStdout();

  useEffect(() => {
    const load = async () => {
      try {
        const configIO = new ConfigIO();
        const project = await configIO.readProjectSpec();
        const deployedState = await configIO.readDeployedState();

        const targetNames = Object.keys(deployedState.targets);
        if (targetNames.length === 0) {
          setError('No deployed targets found. Run `agentcore deploy` first.');
          setLoading(false);
          return;
        }

        const targetName = targetNames[0]!;
        const targetState = deployedState.targets[targetName];

        const loaded: ExecAgent[] = [];
        for (const agent of project.runtimes) {
          const state = targetState?.resources?.runtimes?.[agent.name];
          if (!state?.runtimeArn) continue;
          loaded.push({ name: agent.name, runtimeArn: state.runtimeArn });
        }

        if (loaded.length === 0) {
          setError('No deployed agents found. Run `agentcore deploy` first.');
          setLoading(false);
          return;
        }

        setAgents(loaded);

        // Auto-select when only one agent is deployed
        if (loaded.length === 1) {
          onSelect({ runtimeArn: loaded[0]!.runtimeArn, autoSelected: true });
          return;
        }

        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxVisible = Math.max(3, (stdout?.rows ?? 24) - 8);

  useInput((input, key) => {
    if (loading || error) return;

    if (key.upArrow || input === 'k') {
      setSelectedIndex(i => (i - 1 + agents.length) % agents.length);
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex(i => (i + 1) % agents.length);
    } else if (key.return) {
      const agent = agents[selectedIndex];
      if (agent) onSelect({ runtimeArn: agent.runtimeArn });
    }
  });

  const items = agents.map((a, i) => ({
    id: String(i),
    title: a.name,
    description: a.description,
  }));

  const helpText = HELP_TEXT.NAVIGATE_SELECT;

  if (loading) {
    return (
      <Screen title="AgentCore Exec" onExit={onExit} helpText={helpText}>
        <Text dimColor>Loading agents...</Text>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen title="AgentCore Exec" onExit={onExit} helpText={HELP_TEXT.EXIT}>
        <Box flexDirection="column">
          <Text color="red">{error}</Text>
        </Box>
      </Screen>
    );
  }

  return (
    <Screen title="AgentCore Exec" onExit={onExit} helpText={helpText}>
      <Panel title="Select Agent to Shell Into" fullWidth>
        <SelectList items={items} selectedIndex={selectedIndex} maxVisibleItems={maxVisible} />
      </Panel>
    </Screen>
  );
}
