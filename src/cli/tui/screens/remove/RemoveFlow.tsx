import type { RemovableMcpTool, RemovalPreview } from '../../../operations/remove';
import { ErrorPrompt, Panel, Screen } from '../../components';
import {
  useRemovableAgents,
  useRemovableGateways,
  useRemovableIdentities,
  useRemovableMcpTools,
  useRemovableMemories,
  useRemovableTargets,
  useRemovalPreview,
  useRemoveAgent,
  useRemoveGateway,
  useRemoveIdentity,
  useRemoveMcpTool,
  useRemoveMemory,
  useRemoveTarget,
} from '../../hooks/useRemove';
import { RemoveAgentScreen } from './RemoveAgentScreen';
import { RemoveAllScreen } from './RemoveAllScreen';
import { RemoveConfirmScreen } from './RemoveConfirmScreen';
import { RemoveGatewayScreen } from './RemoveGatewayScreen';
import { RemoveIdentityScreen } from './RemoveIdentityScreen';
import { RemoveMcpToolScreen } from './RemoveMcpToolScreen';
import { RemoveMemoryScreen } from './RemoveMemoryScreen';
import type { RemoveResourceType } from './RemoveScreen';
import { RemoveScreen } from './RemoveScreen';
import { RemoveSuccessScreen } from './RemoveSuccessScreen';
import { RemoveTargetScreen } from './RemoveTargetScreen';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useCallback, useEffect, useRef, useState } from 'react';

type FlowState =
  | { name: 'select' }
  | { name: 'select-agent' }
  | { name: 'select-gateway' }
  | { name: 'select-mcp-tool' }
  | { name: 'select-memory' }
  | { name: 'select-identity' }
  | { name: 'select-target' }
  | { name: 'confirm-agent'; agentName: string; preview: RemovalPreview }
  | { name: 'confirm-gateway'; gatewayName: string; preview: RemovalPreview }
  | { name: 'confirm-mcp-tool'; tool: RemovableMcpTool; preview: RemovalPreview }
  | { name: 'confirm-memory'; memoryName: string; preview: RemovalPreview }
  | { name: 'confirm-identity'; identityName: string; preview: RemovalPreview }
  | { name: 'confirm-target'; targetName: string; preview: RemovalPreview }
  | { name: 'loading'; message: string }
  | { name: 'agent-success'; agentName: string; logFilePath?: string }
  | { name: 'gateway-success'; gatewayName: string; logFilePath?: string }
  | { name: 'tool-success'; toolName: string; logFilePath?: string }
  | { name: 'memory-success'; memoryName: string; logFilePath?: string }
  | { name: 'identity-success'; identityName: string; logFilePath?: string }
  | { name: 'target-success'; targetName: string; logFilePath?: string }
  | { name: 'remove-all' }
  | { name: 'error'; message: string };

interface RemoveFlowProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  /** Callback when user selects a next step command (e.g. deploy) */
  onNavigate?: (command: string) => void;
  /** Force mode - skip confirmation */
  force?: boolean;
  /** Initial resource type to start at (for CLI subcommands) */
  initialResourceType?: 'agent' | 'gateway' | 'mcp-tool' | 'memory' | 'identity' | 'target';
  /** Initial resource name to auto-select (for CLI --name flag) */
  initialResourceName?: string;
}

export function RemoveFlow({
  isInteractive,
  onExit,
  onNavigate,
  force = false,
  initialResourceType,
  initialResourceName,
}: RemoveFlowProps) {
  const getInitialState = (): FlowState => {
    if (!initialResourceType) return { name: 'select' };
    switch (initialResourceType) {
      case 'agent':
        return { name: 'select-agent' };
      case 'gateway':
        return { name: 'select-gateway' };
      case 'mcp-tool':
        return { name: 'select-mcp-tool' };
      case 'memory':
        return { name: 'select-memory' };
      case 'identity':
        return { name: 'select-identity' };
      case 'target':
        return { name: 'select-target' };
      default:
        return { name: 'select' };
    }
  };
  const [flow, setFlow] = useState<FlowState>(getInitialState);

  // Data hooks - need isLoading to avoid showing screen before data loads
  const { agents, isLoading: isLoadingAgents, refresh: refreshAgents } = useRemovableAgents();
  const { gateways, isLoading: isLoadingGateways, refresh: refreshGateways } = useRemovableGateways();
  const { tools: mcpTools, isLoading: isLoadingTools, refresh: refreshTools } = useRemovableMcpTools();
  const { memories, isLoading: isLoadingMemories, refresh: refreshMemories } = useRemovableMemories();
  const { identities, isLoading: isLoadingIdentities, refresh: refreshIdentities } = useRemovableIdentities();
  const { targets, isLoading: isLoadingTargets, refresh: refreshTargets } = useRemovableTargets();

  // Check if any data is still loading
  const isLoading =
    isLoadingAgents ||
    isLoadingGateways ||
    isLoadingTools ||
    isLoadingMemories ||
    isLoadingIdentities ||
    isLoadingTargets;

  // Preview hook
  const {
    loadAgentPreview,
    loadGatewayPreview,
    loadMcpToolPreview,
    loadMemoryPreview,
    loadIdentityPreview,
    loadTargetPreview,
    reset: resetPreview,
  } = useRemovalPreview();

  // Removal hooks
  const { remove: removeAgentOp, reset: resetRemoveAgent } = useRemoveAgent();
  const { remove: removeGatewayOp, reset: resetRemoveGateway } = useRemoveGateway();
  const { remove: removeMcpToolOp, reset: resetRemoveMcpTool } = useRemoveMcpTool();
  const { remove: removeMemoryOp, reset: resetRemoveMemory } = useRemoveMemory();
  const { remove: removeIdentityOp, reset: resetRemoveIdentity } = useRemoveIdentity();
  const { remove: removeTargetOp, reset: resetRemoveTarget } = useRemoveTarget();

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

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive) {
      const successStates = [
        'agent-success',
        'gateway-success',
        'tool-success',
        'memory-success',
        'identity-success',
        'target-success',
      ];
      if (successStates.includes(flow.name)) {
        onExit();
      }
    }
  }, [isInteractive, flow.name, onExit]);

  // Track whether we've already triggered the initial resource selection
  const hasTriggeredInitialSelection = useRef(false);

  const handleSelectResource = useCallback((resourceType: RemoveResourceType) => {
    switch (resourceType) {
      case 'agent':
        setFlow({ name: 'select-agent' });
        break;
      case 'gateway':
        setFlow({ name: 'select-gateway' });
        break;
      case 'mcp-tool':
        setFlow({ name: 'select-mcp-tool' });
        break;
      case 'memory':
        setFlow({ name: 'select-memory' });
        break;
      case 'identity':
        setFlow({ name: 'select-identity' });
        break;
      case 'target':
        setFlow({ name: 'select-target' });
        break;
      case 'all':
        setFlow({ name: 'remove-all' });
        break;
    }
  }, []);

  // Selection handlers that load preview
  // Note: Preview loading reads local JSON files (instant), so no loading screen needed
  const handleSelectAgent = useCallback(
    async (agentName: string) => {
      const result = await loadAgentPreview(agentName);
      if (result.ok) {
        if (force) {
          // Skip confirmation in force mode
          setFlow({ name: 'loading', message: `Removing agent ${agentName}...` });
          const removeResult = await removeAgentOp(agentName, result.preview);
          if (removeResult.ok) {
            setFlow({ name: 'agent-success', agentName });
          } else {
            setFlow({ name: 'error', message: removeResult.error });
          }
        } else {
          setFlow({ name: 'confirm-agent', agentName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadAgentPreview, force, removeAgentOp]
  );

  const handleSelectGateway = useCallback(
    async (gatewayName: string) => {
      const result = await loadGatewayPreview(gatewayName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing gateway ${gatewayName}...` });
          const removeResult = await removeGatewayOp(gatewayName, result.preview);
          if (removeResult.ok) {
            setFlow({ name: 'gateway-success', gatewayName });
          } else {
            setFlow({ name: 'error', message: removeResult.error });
          }
        } else {
          setFlow({ name: 'confirm-gateway', gatewayName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadGatewayPreview, force, removeGatewayOp]
  );

  const handleSelectMcpTool = useCallback(
    async (tool: RemovableMcpTool) => {
      const result = await loadMcpToolPreview(tool);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing MCP tool ${tool.name}...` });
          const removeResult = await removeMcpToolOp(tool, result.preview);
          if (removeResult.ok) {
            setFlow({ name: 'tool-success', toolName: tool.name });
          } else {
            setFlow({ name: 'error', message: removeResult.error });
          }
        } else {
          setFlow({ name: 'confirm-mcp-tool', tool, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadMcpToolPreview, force, removeMcpToolOp]
  );

  const handleSelectMemory = useCallback(
    async (memoryName: string) => {
      const result = await loadMemoryPreview(memoryName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing memory ${memoryName}...` });
          const removeResult = await removeMemoryOp(memoryName, result.preview);
          if (removeResult.ok) {
            setFlow({ name: 'memory-success', memoryName });
          } else {
            setFlow({ name: 'error', message: removeResult.error });
          }
        } else {
          setFlow({ name: 'confirm-memory', memoryName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadMemoryPreview, force, removeMemoryOp]
  );

  const handleSelectIdentity = useCallback(
    async (identityName: string) => {
      const result = await loadIdentityPreview(identityName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing identity ${identityName}...` });
          const removeResult = await removeIdentityOp(identityName, result.preview);
          if (removeResult.ok) {
            setFlow({ name: 'identity-success', identityName });
          } else {
            setFlow({ name: 'error', message: removeResult.error });
          }
        } else {
          setFlow({ name: 'confirm-identity', identityName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadIdentityPreview, force, removeIdentityOp]
  );

  const handleSelectTarget = useCallback(
    async (targetName: string) => {
      const result = await loadTargetPreview(targetName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing target ${targetName}...` });
          const removeResult = await removeTargetOp(targetName, result.preview);
          if (removeResult.ok) {
            setFlow({ name: 'target-success', targetName });
          } else {
            setFlow({ name: 'error', message: removeResult.error });
          }
        } else {
          setFlow({ name: 'confirm-target', targetName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadTargetPreview, force, removeTargetOp]
  );

  // Auto-select resource when initialResourceName is provided and data is loaded
  useEffect(() => {
    if (!initialResourceName || isLoading || hasTriggeredInitialSelection.current) {
      return;
    }

    // Only trigger once
    hasTriggeredInitialSelection.current = true;

    // Use setTimeout to avoid eslint cascading renders warning
    setTimeout(() => {
      switch (initialResourceType) {
        case 'agent':
          void handleSelectAgent(initialResourceName);
          break;
        case 'gateway':
          void handleSelectGateway(initialResourceName);
          break;
        case 'memory':
          void handleSelectMemory(initialResourceName);
          break;
        case 'identity':
          void handleSelectIdentity(initialResourceName);
          break;
        case 'target':
          void handleSelectTarget(initialResourceName);
          break;
      }
    }, 0);
  }, [
    initialResourceName,
    initialResourceType,
    isLoading,
    handleSelectAgent,
    handleSelectGateway,
    handleSelectMemory,
    handleSelectIdentity,
    handleSelectTarget,
  ]);

  // Confirm handlers - pass preview for logging
  const handleConfirmAgent = useCallback(
    async (agentName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing agent ${agentName}...` });
      const result = await removeAgentOp(agentName, preview);
      if (result.ok) {
        pendingResultRef.current = { name: 'agent-success', agentName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error };
      }
      setResultReady(true);
    },
    [removeAgentOp]
  );

  const handleConfirmGateway = useCallback(
    async (gatewayName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing gateway ${gatewayName}...` });
      const result = await removeGatewayOp(gatewayName, preview);
      if (result.ok) {
        pendingResultRef.current = { name: 'gateway-success', gatewayName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error };
      }
      setResultReady(true);
    },
    [removeGatewayOp]
  );

  const handleConfirmMcpTool = useCallback(
    async (tool: RemovableMcpTool, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing MCP tool ${tool.name}...` });
      const result = await removeMcpToolOp(tool, preview);
      if (result.ok) {
        pendingResultRef.current = { name: 'tool-success', toolName: tool.name, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error };
      }
      setResultReady(true);
    },
    [removeMcpToolOp]
  );

  const handleConfirmMemory = useCallback(
    async (memoryName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing memory ${memoryName}...` });
      const result = await removeMemoryOp(memoryName, preview);
      if (result.ok) {
        pendingResultRef.current = { name: 'memory-success', memoryName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error };
      }
      setResultReady(true);
    },
    [removeMemoryOp]
  );

  const handleConfirmIdentity = useCallback(
    async (identityName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing identity ${identityName}...` });
      const result = await removeIdentityOp(identityName, preview);
      if (result.ok) {
        pendingResultRef.current = { name: 'identity-success', identityName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error };
      }
      setResultReady(true);
    },
    [removeIdentityOp]
  );

  const handleConfirmTarget = useCallback(
    async (targetName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing target ${targetName}...` });
      const result = await removeTargetOp(targetName, preview);
      if (result.ok) {
        pendingResultRef.current = { name: 'target-success', targetName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error };
      }
      setResultReady(true);
    },
    [removeTargetOp]
  );

  const resetAll = useCallback(() => {
    resetPreview();
    resetRemoveAgent();
    resetRemoveGateway();
    resetRemoveMcpTool();
    resetRemoveMemory();
    resetRemoveIdentity();
    resetRemoveTarget();
  }, [
    resetPreview,
    resetRemoveAgent,
    resetRemoveGateway,
    resetRemoveMcpTool,
    resetRemoveMemory,
    resetRemoveIdentity,
    resetRemoveTarget,
  ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshGateways(),
      refreshTools(),
      refreshMemories(),
      refreshIdentities(),
      refreshTargets(),
    ]);
  }, [refreshAgents, refreshGateways, refreshTools, refreshMemories, refreshIdentities, refreshTargets]);

  // Select screen - wait for data to load to avoid arrow position issues
  if (flow.name === 'select') {
    if (isLoading) {
      return null;
    }
    return (
      <RemoveScreen
        onSelect={handleSelectResource}
        onExit={onExit}
        agentCount={agents.length}
        gatewayCount={gateways.length}
        mcpToolCount={mcpTools.length}
        memoryCount={memories.length}
        identityCount={identities.length}
        targetCount={targets.length}
      />
    );
  }

  // Loading screen
  if (flow.name === 'loading') {
    const noop = () => undefined;
    return (
      <Screen title="Remove Resource" onExit={noop}>
        <Panel>
          <Text>
            <Spinner type="dots" /> {flow.message}
          </Text>
        </Panel>
      </Screen>
    );
  }

  // Selection screens
  if (flow.name === 'select-agent') {
    // If initialResourceName is provided, wait for data loading (which triggers auto-select)
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveAgentScreen
        agents={agents}
        onSelect={(name: string) => void handleSelectAgent(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-gateway') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveGatewayScreen
        gateways={gateways}
        onSelect={(name: string) => void handleSelectGateway(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-mcp-tool') {
    return (
      <RemoveMcpToolScreen
        tools={mcpTools}
        onSelect={(tool: RemovableMcpTool) => void handleSelectMcpTool(tool)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-memory') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveMemoryScreen
        memories={memories}
        onSelect={(name: string) => void handleSelectMemory(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-identity') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveIdentityScreen
        identities={identities}
        onSelect={(name: string) => void handleSelectIdentity(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-target') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveTargetScreen
        targets={targets}
        onSelect={(name: string) => void handleSelectTarget(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  // Confirmation screens
  if (flow.name === 'confirm-agent') {
    return (
      <RemoveConfirmScreen
        title={`Remove Agent: ${flow.agentName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmAgent(flow.agentName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-agent' })}
      />
    );
  }

  if (flow.name === 'confirm-gateway') {
    return (
      <RemoveConfirmScreen
        title={`Remove Gateway: ${flow.gatewayName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmGateway(flow.gatewayName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-gateway' })}
      />
    );
  }

  if (flow.name === 'confirm-mcp-tool') {
    return (
      <RemoveConfirmScreen
        title={`Remove MCP Tool: ${flow.tool.name}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmMcpTool(flow.tool, flow.preview)}
        onCancel={() => setFlow({ name: 'select-mcp-tool' })}
      />
    );
  }

  if (flow.name === 'confirm-memory') {
    return (
      <RemoveConfirmScreen
        title={`Remove Memory: ${flow.memoryName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmMemory(flow.memoryName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-memory' })}
      />
    );
  }

  if (flow.name === 'confirm-identity') {
    return (
      <RemoveConfirmScreen
        title={`Remove Identity: ${flow.identityName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmIdentity(flow.identityName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-identity' })}
      />
    );
  }

  if (flow.name === 'confirm-target') {
    return (
      <RemoveConfirmScreen
        title={`Remove Target: ${flow.targetName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmTarget(flow.targetName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-target' })}
      />
    );
  }

  // Success screens
  if (flow.name === 'agent-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed agent: ${flow.agentName}`}
        detail="Agent removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'gateway-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed gateway: ${flow.gatewayName}`}
        detail="Gateway removed from mcp.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'tool-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed MCP tool: ${flow.toolName}`}
        detail="MCP tool removed. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'memory-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed memory: ${flow.memoryName}`}
        detail="Memory provider removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'identity-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed identity: ${flow.identityName}`}
        detail="Identity provider removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'target-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed target: ${flow.targetName}`}
        detail="Deployment target removed from aws-targets.json."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  // Remove all screen
  if (flow.name === 'remove-all') {
    return <RemoveAllScreen isInteractive={isInteractive} onExit={onExit} onNavigate={onNavigate} />;
  }

  // Error screen
  return (
    <ErrorPrompt
      message="Failed to remove resource"
      detail={flow.message}
      onBack={() => {
        resetAll();
        setFlow({ name: 'select' });
      }}
      onExit={onExit}
    />
  );
}
