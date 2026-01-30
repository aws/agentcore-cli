import {
  ErrorPrompt,
  type NextStep,
  NextSteps,
  Panel,
  Screen,
  SelectScreen,
  type SelectableItem,
} from '../../components';
import {
  useAgentAttachments,
  useAgents,
  useAttachAgent,
  useAttachGateway,
  useAttachIdentity,
  useAttachMemory,
  useBindMcpRuntime,
  useGateways,
  useMcpRuntimeTools,
  useOwnedIdentities,
  useOwnedMemories,
} from '../../hooks/useAttach';
import { AttachAgentScreen } from './AttachAgentScreen';
import { AttachGatewayScreen } from './AttachGatewayScreen';
import { AttachIdentityScreen } from './AttachIdentityScreen';
import { AttachMcpRuntimeScreen } from './AttachMcpRuntimeScreen';
import { AttachMemoryScreen } from './AttachMemoryScreen';
import type { AttachResourceType } from './AttachScreen';
import { AttachScreen } from './AttachScreen';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type FlowState =
  | { name: 'select-agent' }
  | { name: 'select-resource'; sourceAgent: string }
  | { name: 'attach-agent'; sourceAgent: string }
  | { name: 'attach-memory'; sourceAgent: string }
  | { name: 'attach-identity'; sourceAgent: string }
  | { name: 'attach-mcp-runtime'; sourceAgent: string }
  | { name: 'attach-gateway'; sourceAgent: string }
  | { name: 'loading'; message: string }
  | { name: 'success'; resourceType: string; resourceName: string; sourceAgent: string }
  | { name: 'error'; message: string };

export function AttachFlow(props: { onExit: () => void }) {
  const { agents, isLoading: isLoadingAgents, refresh: refreshAgents } = useAgents();
  const { memories } = useOwnedMemories();
  const { identities } = useOwnedIdentities();
  const { tools: mcpRuntimes } = useMcpRuntimeTools();
  const { gateways } = useGateways();

  const { attach: attachAgent, reset: resetAttachAgent } = useAttachAgent();
  const { attach: attachMemory, reset: resetAttachMemory } = useAttachMemory();
  const { attach: attachIdentity, reset: resetAttachIdentity } = useAttachIdentity();
  const { bind: bindMcpRuntime, reset: resetBindMcpRuntime } = useBindMcpRuntime();
  const { attach: attachGateway, reset: resetAttachGateway } = useAttachGateway();

  const [flow, setFlow] = useState<FlowState>({ name: 'select-agent' });
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  // Get current agent's existing attachments
  const attachments = useAgentAttachments(selectedAgent);

  // Track pending result state
  const pendingResultRef = useRef<FlowState | null>(null);
  const [resultReady, setResultReady] = useState(false);

  // Process pending result after loading screen has rendered
  useEffect(() => {
    if (flow.name === 'loading' && resultReady && pendingResultRef.current) {
      const pendingResult = pendingResultRef.current;
      pendingResultRef.current = null;
      setTimeout(() => {
        setResultReady(false);
        setFlow(pendingResult);
      }, 0);
    }
  }, [flow.name, resultReady]);

  // Calculate available resources (exclude already attached)
  const otherAgents = useMemo(() => {
    if (!selectedAgent) return [];
    return agents.filter(a => a !== selectedAgent && !attachments.remoteTools.includes(a));
  }, [agents, selectedAgent, attachments.remoteTools]);

  const availableMemories = useMemo(() => {
    return memories
      .filter(m => m.ownerAgent !== selectedAgent)
      .filter(m => !attachments.memories.includes(m.name))
      .map(m => m.name);
  }, [memories, selectedAgent, attachments.memories]);

  const availableIdentities = useMemo(() => {
    return identities
      .filter(i => i.ownerAgent !== selectedAgent)
      .filter(i => !attachments.identities.includes(i.name))
      .map(i => i.name);
  }, [identities, selectedAgent, attachments.identities]);

  const availableMcpRuntimes = useMemo(() => {
    // Filter out already attached MCP runtimes
    return mcpRuntimes.filter(r => !attachments.remoteTools.includes(r));
  }, [mcpRuntimes, attachments.remoteTools]);

  const availableGateways = useMemo(() => {
    // Filter out already attached gateways
    return gateways.filter(g => !attachments.mcpProviders.includes(g));
  }, [gateways, attachments.mcpProviders]);

  const handleSelectAgent = useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    setFlow({ name: 'select-resource', sourceAgent: agentName });
  }, []);

  const handleSelectResource = useCallback(
    (resourceType: AttachResourceType) => {
      if (!selectedAgent) return;
      switch (resourceType) {
        case 'agent':
          setFlow({ name: 'attach-agent', sourceAgent: selectedAgent });
          break;
        case 'memory':
          setFlow({ name: 'attach-memory', sourceAgent: selectedAgent });
          break;
        case 'identity':
          setFlow({ name: 'attach-identity', sourceAgent: selectedAgent });
          break;
        case 'mcp-runtime':
          setFlow({ name: 'attach-mcp-runtime', sourceAgent: selectedAgent });
          break;
        case 'gateway':
          setFlow({ name: 'attach-gateway', sourceAgent: selectedAgent });
          break;
      }
    },
    [selectedAgent]
  );

  const handleBack = useCallback(() => {
    if (selectedAgent) {
      setFlow({ name: 'select-resource', sourceAgent: selectedAgent });
    } else {
      setFlow({ name: 'select-agent' });
    }
  }, [selectedAgent]);

  const resetAll = useCallback(() => {
    resetAttachAgent();
    resetAttachMemory();
    resetAttachIdentity();
    resetBindMcpRuntime();
    resetAttachGateway();
  }, [resetAttachAgent, resetAttachMemory, resetAttachIdentity, resetBindMcpRuntime, resetAttachGateway]);

  // Return null while loading to keep previous screen visible (avoids flash)
  if (isLoadingAgents) {
    return null;
  }

  // No agents in project
  if (agents.length === 0) {
    return (
      <ErrorPrompt
        message="No agents in project"
        detail="Add an agent first using the 'add' command."
        onBack={props.onExit}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'select-agent') {
    const items: SelectableItem[] = agents.map(a => ({
      id: a,
      title: a,
    }));

    return (
      <SelectScreen
        title="Select agent to attach resources to"
        items={items}
        onSelect={item => handleSelectAgent(item.id)}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'select-resource') {
    return (
      <AttachScreen
        sourceAgent={flow.sourceAgent}
        onSelect={handleSelectResource}
        onExit={() => setFlow({ name: 'select-agent' })}
        otherAgents={otherAgents}
        availableMemories={availableMemories}
        availableIdentities={availableIdentities}
        availableMcpRuntimes={availableMcpRuntimes}
        availableGateways={availableGateways}
      />
    );
  }

  if (flow.name === 'loading') {
    const noop = () => undefined;
    return (
      <Screen title="Attach Resource" onExit={noop}>
        <Panel>
          <Text>
            <Spinner type="dots" /> {flow.message}
          </Text>
        </Panel>
      </Screen>
    );
  }

  if (flow.name === 'attach-agent') {
    return (
      <AttachAgentScreen
        sourceAgent={flow.sourceAgent}
        availableAgents={otherAgents}
        onComplete={config => {
          void (async () => {
            pendingResultRef.current = null;
            setResultReady(false);
            setFlow({ name: 'loading', message: 'Attaching agent...' });
            const result = await attachAgent(flow.sourceAgent, config);
            if (result.ok) {
              pendingResultRef.current = {
                name: 'success',
                resourceType: 'Agent',
                resourceName: config.targetAgent,
                sourceAgent: flow.sourceAgent,
              };
            } else {
              pendingResultRef.current = { name: 'error', message: result.error };
            }
            setResultReady(true);
          })();
        }}
        onExit={handleBack}
      />
    );
  }

  if (flow.name === 'attach-memory') {
    return (
      <AttachMemoryScreen
        sourceAgent={flow.sourceAgent}
        availableMemories={availableMemories}
        onComplete={config => {
          void (async () => {
            pendingResultRef.current = null;
            setResultReady(false);
            setFlow({ name: 'loading', message: 'Attaching memory...' });
            const result = await attachMemory(flow.sourceAgent, config);
            if (result.ok) {
              pendingResultRef.current = {
                name: 'success',
                resourceType: 'Memory',
                resourceName: config.memoryName,
                sourceAgent: flow.sourceAgent,
              };
            } else {
              pendingResultRef.current = { name: 'error', message: result.error };
            }
            setResultReady(true);
          })();
        }}
        onExit={handleBack}
      />
    );
  }

  if (flow.name === 'attach-identity') {
    return (
      <AttachIdentityScreen
        sourceAgent={flow.sourceAgent}
        availableIdentities={availableIdentities}
        onComplete={config => {
          void (async () => {
            pendingResultRef.current = null;
            setResultReady(false);
            setFlow({ name: 'loading', message: 'Attaching identity...' });
            const result = await attachIdentity(flow.sourceAgent, config);
            if (result.ok) {
              pendingResultRef.current = {
                name: 'success',
                resourceType: 'Identity',
                resourceName: config.identityName,
                sourceAgent: flow.sourceAgent,
              };
            } else {
              pendingResultRef.current = { name: 'error', message: result.error };
            }
            setResultReady(true);
          })();
        }}
        onExit={handleBack}
      />
    );
  }

  if (flow.name === 'attach-mcp-runtime') {
    return (
      <AttachMcpRuntimeScreen
        sourceAgent={flow.sourceAgent}
        availableMcpRuntimes={availableMcpRuntimes}
        onComplete={(mcpRuntimeName, config) => {
          void (async () => {
            pendingResultRef.current = null;
            setResultReady(false);
            setFlow({ name: 'loading', message: 'Binding agent to MCP runtime...' });
            const result = await bindMcpRuntime(mcpRuntimeName, config);
            if (result.ok) {
              pendingResultRef.current = {
                name: 'success',
                resourceType: 'MCP Runtime',
                resourceName: mcpRuntimeName,
                sourceAgent: flow.sourceAgent,
              };
            } else {
              pendingResultRef.current = { name: 'error', message: result.error };
            }
            setResultReady(true);
          })();
        }}
        onExit={handleBack}
      />
    );
  }

  if (flow.name === 'attach-gateway') {
    return (
      <AttachGatewayScreen
        sourceAgent={flow.sourceAgent}
        availableGateways={availableGateways}
        onComplete={config => {
          void (async () => {
            pendingResultRef.current = null;
            setResultReady(false);
            setFlow({ name: 'loading', message: 'Attaching gateway...' });
            const result = await attachGateway(flow.sourceAgent, config);
            if (result.ok) {
              pendingResultRef.current = {
                name: 'success',
                resourceType: 'Gateway',
                resourceName: config.gatewayName,
                sourceAgent: flow.sourceAgent,
              };
            } else {
              pendingResultRef.current = { name: 'error', message: result.error };
            }
            setResultReady(true);
          })();
        }}
        onExit={handleBack}
      />
    );
  }

  if (flow.name === 'success') {
    const attachSuccessSteps: NextStep[] = [{ command: 'attach', label: 'Attach another resource' }];

    const handleSuccessSelect = (step: NextStep) => {
      if (step.command === 'attach') {
        void refreshAgents().then(() => {
          setFlow({ name: 'select-resource', sourceAgent: flow.sourceAgent });
        });
      }
    };

    return (
      <Screen title="Success" onExit={props.onExit}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text color="green">
              ✓ Attached {flow.resourceType}: {flow.resourceName}
            </Text>
            <Text>
              {flow.resourceType} attached to agent &quot;{flow.sourceAgent}&quot;. Deploy with `agentcore deploy`.
            </Text>
          </Box>
          <NextSteps
            steps={attachSuccessSteps}
            isInteractive={true}
            onSelect={handleSuccessSelect}
            onBack={props.onExit}
          />
        </Box>
      </Screen>
    );
  }

  // Error state
  return (
    <ErrorPrompt
      message="Failed to attach resource"
      detail={flow.message}
      onBack={() => {
        resetAll();
        if (selectedAgent) {
          setFlow({ name: 'select-resource', sourceAgent: selectedAgent });
        } else {
          setFlow({ name: 'select-agent' });
        }
      }}
      onExit={props.onExit}
    />
  );
}
