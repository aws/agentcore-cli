import { ConfigIO } from '../../../../lib';
import type { AgentCoreProjectSpec } from '../../../../schema';
import { Screen, SelectList } from '../../components';
import type { SelectableItem } from '../../components';
import { ResourceGraph } from '../../components/ResourceGraph';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

interface OutlineScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'loading' | 'ready' | 'error';
type Mode = 'select-scope' | 'select-agent' | 'view';

const SCOPE_ITEMS: SelectableItem[] = [
  { id: 'all', title: 'All Resources' },
  { id: 'agent', title: 'Single Agent' },
];

export function OutlineScreen({ isInteractive: _isInteractive, onExit }: OutlineScreenProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [mode, setMode] = useState<Mode>('select-scope');
  const [projectSpec, setProjectSpec] = useState<AgentCoreProjectSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [agentName, setAgentName] = useState<string | null>(null);

  useEffect(() => {
    const loadProject = async () => {
      try {
        const configIO = new ConfigIO();
        const spec = await configIO.readProjectSpec();
        setProjectSpec(spec);
        setPhase('ready');
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    };

    void loadProject();
  }, []);

  const agentItems: SelectableItem[] = useMemo(
    () => (projectSpec?.agents ?? []).map(a => ({ id: a.name, title: a.name })),
    [projectSpec]
  );

  useInput((input, key) => {
    if (phase !== 'ready' || !projectSpec) return;

    if (mode === 'select-scope') {
      if (key.upArrow) setSelectedScope(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedScope(i => Math.min(SCOPE_ITEMS.length - 1, i + 1));
      if (key.return) {
        const selectedItem = SCOPE_ITEMS[selectedScope];
        if (selectedItem?.id === 'all') {
          setAgentName(null);
          setMode('view');
        } else {
          setMode('select-agent');
        }
      }
    } else if (mode === 'select-agent') {
      if (key.upArrow) setSelectedAgent(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedAgent(i => Math.min(agentItems.length - 1, i + 1));
      if (key.return && agentItems[selectedAgent]) {
        setAgentName(agentItems[selectedAgent].id);
        setMode('view');
      }
      if (key.escape) setMode('select-scope');
    } else if (mode === 'view') {
      if (key.escape || (key.ctrl && input === 'q')) setMode('select-scope');
    }
  });

  // Return null while loading to keep previous screen visible (avoids flash)
  if (phase === 'loading') {
    return null;
  }

  if (phase === 'error' || !projectSpec) {
    return (
      <Screen title="Project Outline" onExit={onExit}>
        <Text color="red">{error ?? 'Failed to load project'}</Text>
      </Screen>
    );
  }

  if (mode === 'select-scope') {
    return (
      <Screen title="Project Outline" onExit={onExit}>
        <Box flexDirection="column">
          <Text>Select scope:</Text>
          <SelectList items={SCOPE_ITEMS} selectedIndex={selectedScope} />
        </Box>
      </Screen>
    );
  }

  if (mode === 'select-agent') {
    return (
      <Screen title="Project Outline" onExit={onExit}>
        <Box flexDirection="column">
          <Text>Select agent:</Text>
          <SelectList items={agentItems} selectedIndex={selectedAgent} />
        </Box>
      </Screen>
    );
  }

  return (
    <Screen title="Project Outline" onExit={onExit} helpText="ESC back">
      <ResourceGraph project={projectSpec} mcp={projectSpec.mcp} agentName={agentName ?? undefined} />
    </Screen>
  );
}
