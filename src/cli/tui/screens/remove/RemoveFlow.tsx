import type { RemovableGatewayTarget, RemovalPreview } from '../../../operations/remove';
import { ErrorPrompt, Panel, Screen } from '../../components';
import {
  useRemovableABTests,
  useRemovableAgents,
  useRemovableConfigBundles,
  useRemovableEvaluators,
  useRemovableGatewayTargets,
  useRemovableGateways,
  useRemovableIdentities,
  useRemovableMemories,
  useRemovableOnlineEvalConfigs,
  useRemovablePolicies,
  useRemovablePolicyEngines,
  useRemovableRuntimeEndpoints,
  useRemovalPreview,
  useRemoveABTest,
  useRemoveAgent,
  useRemoveConfigBundle,
  useRemoveEvaluator,
  useRemoveGateway,
  useRemoveGatewayTarget,
  useRemoveIdentity,
  useRemoveMemory,
  useRemoveOnlineEvalConfig,
  useRemovePolicy,
  useRemovePolicyEngine,
  useRemoveRuntimeEndpoint,
} from '../../hooks/useRemove';
import { RemoveABTestScreen } from '../ab-test/RemoveABTestScreen';
import { RemoveAgentScreen } from './RemoveAgentScreen';
import { RemoveAllScreen } from './RemoveAllScreen';
import { RemoveConfigBundleScreen } from './RemoveConfigBundleScreen';
import { RemoveConfirmScreen } from './RemoveConfirmScreen';
import { RemoveEvaluatorScreen } from './RemoveEvaluatorScreen';
import { RemoveGatewayScreen } from './RemoveGatewayScreen';
import { RemoveGatewayTargetScreen } from './RemoveGatewayTargetScreen';
import { RemoveIdentityScreen } from './RemoveIdentityScreen';
import { RemoveMemoryScreen } from './RemoveMemoryScreen';
import { RemoveOnlineEvalScreen } from './RemoveOnlineEvalScreen';
import { RemovePolicyEngineScreen } from './RemovePolicyEngineScreen';
import { RemovePolicyScreen } from './RemovePolicyScreen';
import { RemoveRuntimeEndpointScreen } from './RemoveRuntimeEndpointScreen';
import type { RemoveResourceType } from './RemoveScreen';
import { RemoveScreen } from './RemoveScreen';
import { RemoveSuccessScreen } from './RemoveSuccessScreen';
import { Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useCallback, useEffect, useRef, useState } from 'react';

type FlowState =
  | { name: 'select' }
  | { name: 'select-agent' }
  | { name: 'select-gateway' }
  | { name: 'select-gateway-target' }
  | { name: 'select-memory' }
  | { name: 'select-identity' }
  | { name: 'select-evaluator' }
  | { name: 'select-online-eval' }
  | { name: 'select-policy-engine' }
  | { name: 'select-policy' }
  | { name: 'select-config-bundle' }
  | { name: 'select-ab-test' }
  | { name: 'select-runtime-endpoint' }
  | { name: 'confirm-agent'; agentName: string; preview: RemovalPreview }
  | { name: 'confirm-gateway'; gatewayName: string; preview: RemovalPreview }
  | { name: 'confirm-gateway-target'; tool: RemovableGatewayTarget; preview: RemovalPreview }
  | { name: 'confirm-memory'; memoryName: string; preview: RemovalPreview }
  | { name: 'confirm-identity'; identityName: string; preview: RemovalPreview }
  | { name: 'confirm-evaluator'; evaluatorName: string; preview: RemovalPreview }
  | { name: 'confirm-online-eval'; configName: string; preview: RemovalPreview }
  | { name: 'confirm-policy-engine'; engineName: string; preview: RemovalPreview }
  | { name: 'confirm-policy'; compositeKey: string; policyName: string; preview: RemovalPreview }
  | { name: 'confirm-config-bundle'; bundleName: string; preview: RemovalPreview }
  | { name: 'confirm-ab-test'; testName: string; preview: RemovalPreview }
  | { name: 'confirm-runtime-endpoint'; endpointName: string; preview: RemovalPreview }
  | { name: 'loading'; message: string }
  | { name: 'agent-success'; agentName: string; logFilePath?: string }
  | { name: 'gateway-success'; gatewayName: string; logFilePath?: string }
  | { name: 'tool-success'; toolName: string; logFilePath?: string }
  | { name: 'memory-success'; memoryName: string; logFilePath?: string }
  | { name: 'identity-success'; identityName: string; logFilePath?: string }
  | { name: 'evaluator-success'; evaluatorName: string; logFilePath?: string }
  | { name: 'online-eval-success'; configName: string; logFilePath?: string }
  | { name: 'policy-engine-success'; engineName: string; logFilePath?: string }
  | { name: 'policy-success'; policyName: string; logFilePath?: string }
  | { name: 'config-bundle-success'; bundleName: string; logFilePath?: string }
  | { name: 'ab-test-success'; testName: string; logFilePath?: string }
  | { name: 'runtime-endpoint-success'; endpointName: string; logFilePath?: string }
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
  initialResourceType?:
    | 'agent'
    | 'gateway'
    | 'gateway-target'
    | 'runtime-endpoint'
    | 'memory'
    | 'credential'
    | 'evaluator'
    | 'online-eval'
    | 'policy-engine'
    | 'policy'
    | 'config-bundle'
    | 'ab-test';
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
      case 'gateway-target':
        return { name: 'select-gateway-target' };
      case 'memory':
        return { name: 'select-memory' };
      case 'credential':
        return { name: 'select-identity' };
      case 'evaluator':
        return { name: 'select-evaluator' };
      case 'online-eval':
        return { name: 'select-online-eval' };
      case 'policy-engine':
        return { name: 'select-policy-engine' };
      case 'policy':
        return { name: 'select-policy' };
      case 'config-bundle':
        return { name: 'select-config-bundle' };
      case 'ab-test':
        return { name: 'select-ab-test' };
      case 'runtime-endpoint':
        return { name: 'select-runtime-endpoint' };
      default:
        return { name: 'select' };
    }
  };
  const [flow, setFlow] = useState<FlowState>(getInitialState);

  // Data hooks - need isLoading to avoid showing screen before data loads
  const { agents, isLoading: isLoadingAgents, refresh: refreshAgents } = useRemovableAgents();
  const { gateways, isLoading: isLoadingGateways, refresh: refreshGateways } = useRemovableGateways();
  const { tools: mcpTools, isLoading: isLoadingTools, refresh: refreshTools } = useRemovableGatewayTargets();
  const { memories, isLoading: isLoadingMemories, refresh: refreshMemories } = useRemovableMemories();
  const { identities, isLoading: isLoadingIdentities, refresh: refreshIdentities } = useRemovableIdentities();
  const { evaluators, isLoading: isLoadingEvaluators, refresh: refreshEvaluators } = useRemovableEvaluators();
  const {
    onlineEvalConfigs,
    isLoading: isLoadingOnlineEvals,
    refresh: refreshOnlineEvals,
  } = useRemovableOnlineEvalConfigs();
  const {
    policyEngines,
    isLoading: isLoadingPolicyEngines,
    refresh: refreshPolicyEngines,
  } = useRemovablePolicyEngines();
  const { policies, isLoading: isLoadingPolicies, refresh: refreshPolicies } = useRemovablePolicies();
  const {
    configBundles,
    isLoading: isLoadingConfigBundles,
    refresh: refreshConfigBundles,
  } = useRemovableConfigBundles();
  const { abTests } = useRemovableABTests();
  const {
    endpoints: runtimeEndpoints,
    isLoading: isLoadingRuntimeEndpoints,
    refresh: refreshRuntimeEndpoints,
  } = useRemovableRuntimeEndpoints();

  // Check if any data is still loading
  const isLoading =
    isLoadingAgents ||
    isLoadingGateways ||
    isLoadingTools ||
    isLoadingMemories ||
    isLoadingIdentities ||
    isLoadingEvaluators ||
    isLoadingOnlineEvals ||
    isLoadingPolicyEngines ||
    isLoadingPolicies ||
    isLoadingConfigBundles ||
    isLoadingRuntimeEndpoints;

  // Preview hook
  const {
    loadAgentPreview,
    loadGatewayPreview,
    loadGatewayTargetPreview,
    loadMemoryPreview,
    loadIdentityPreview,
    loadEvaluatorPreview,
    loadOnlineEvalPreview,
    loadPolicyEnginePreview,
    loadPolicyPreview,
    loadConfigBundlePreview,
    loadABTestPreview,
    loadRuntimeEndpointPreview,
    reset: resetPreview,
  } = useRemovalPreview();

  // Removal hooks
  const { remove: removeAgentOp, reset: resetRemoveAgent } = useRemoveAgent();
  const { remove: removeGatewayOp, reset: resetRemoveGateway } = useRemoveGateway();
  const { remove: removeGatewayTargetOp, reset: resetRemoveGatewayTarget } = useRemoveGatewayTarget();
  const { remove: removeMemoryOp, reset: resetRemoveMemory } = useRemoveMemory();
  const { remove: removeIdentityOp, reset: resetRemoveIdentity } = useRemoveIdentity();
  const { remove: removeEvaluatorOp, reset: resetRemoveEvaluator } = useRemoveEvaluator();
  const { remove: removeOnlineEvalOp, reset: resetRemoveOnlineEval } = useRemoveOnlineEvalConfig();
  const { remove: removePolicyEngineOp, reset: resetRemovePolicyEngine } = useRemovePolicyEngine();
  const { remove: removePolicyOp, reset: resetRemovePolicy } = useRemovePolicy();
  const { remove: removeConfigBundleOp, reset: resetRemoveConfigBundle } = useRemoveConfigBundle();
  const { remove: removeABTestOp, reset: resetRemoveABTest } = useRemoveABTest();
  const { remove: removeRuntimeEndpointOp, reset: resetRemoveRuntimeEndpoint } = useRemoveRuntimeEndpoint();

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
        'evaluator-success',
        'online-eval-success',
        'policy-engine-success',
        'policy-success',
        'config-bundle-success',
        'ab-test-success',
        'runtime-endpoint-success',
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
      case 'gateway-target':
        setFlow({ name: 'select-gateway-target' });
        break;
      case 'memory':
        setFlow({ name: 'select-memory' });
        break;
      case 'credential':
        setFlow({ name: 'select-identity' });
        break;
      case 'evaluator':
        setFlow({ name: 'select-evaluator' });
        break;
      case 'online-eval':
        setFlow({ name: 'select-online-eval' });
        break;
      case 'policy-engine':
        setFlow({ name: 'select-policy-engine' });
        break;
      case 'policy':
        setFlow({ name: 'select-policy' });
        break;
      case 'config-bundle':
        setFlow({ name: 'select-config-bundle' });
        break;
      case 'ab-test':
        setFlow({ name: 'select-ab-test' });
        break;
      case 'runtime-endpoint':
        setFlow({ name: 'select-runtime-endpoint' });
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
          if (removeResult.success) {
            setFlow({ name: 'agent-success', agentName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
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
          if (removeResult.success) {
            setFlow({ name: 'gateway-success', gatewayName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
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

  const handleSelectGatewayTarget = useCallback(
    async (tool: RemovableGatewayTarget) => {
      const result = await loadGatewayTargetPreview(tool);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing gateway target ${tool.name}...` });
          const removeResult = await removeGatewayTargetOp(tool, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'tool-success', toolName: tool.name });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-gateway-target', tool, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadGatewayTargetPreview, force, removeGatewayTargetOp]
  );

  const handleSelectMemory = useCallback(
    async (memoryName: string) => {
      const result = await loadMemoryPreview(memoryName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing memory ${memoryName}...` });
          const removeResult = await removeMemoryOp(memoryName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'memory-success', memoryName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
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
          if (removeResult.success) {
            setFlow({ name: 'identity-success', identityName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
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

  const handleSelectEvaluator = useCallback(
    async (evaluatorName: string) => {
      const result = await loadEvaluatorPreview(evaluatorName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing evaluator ${evaluatorName}...` });
          const removeResult = await removeEvaluatorOp(evaluatorName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'evaluator-success', evaluatorName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-evaluator', evaluatorName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadEvaluatorPreview, force, removeEvaluatorOp]
  );

  const handleSelectOnlineEval = useCallback(
    async (configName: string) => {
      const result = await loadOnlineEvalPreview(configName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing online eval config ${configName}...` });
          const removeResult = await removeOnlineEvalOp(configName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'online-eval-success', configName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-online-eval', configName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadOnlineEvalPreview, force, removeOnlineEvalOp]
  );

  const handleSelectPolicyEngine = useCallback(
    async (engineName: string) => {
      const result = await loadPolicyEnginePreview(engineName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing policy engine ${engineName}...` });
          const removeResult = await removePolicyEngineOp(engineName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'policy-engine-success', engineName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-policy-engine', engineName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadPolicyEnginePreview, force, removePolicyEngineOp]
  );

  const handleSelectPolicy = useCallback(
    async (compositeKey: string) => {
      const result = await loadPolicyPreview(compositeKey);
      if (result.ok) {
        const policyName = compositeKey.includes('/')
          ? compositeKey.slice(compositeKey.indexOf('/') + 1)
          : compositeKey;
        if (force) {
          setFlow({ name: 'loading', message: `Removing policy ${policyName}...` });
          const removeResult = await removePolicyOp(compositeKey, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'policy-success', policyName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-policy', compositeKey, policyName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadPolicyPreview, force, removePolicyOp]
  );

  const handleSelectConfigBundle = useCallback(
    async (bundleName: string) => {
      const result = await loadConfigBundlePreview(bundleName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing configuration bundle ${bundleName}...` });
          const removeResult = await removeConfigBundleOp(bundleName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'config-bundle-success', bundleName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-config-bundle', bundleName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadConfigBundlePreview, force, removeConfigBundleOp]
  );

  const handleSelectABTest = useCallback(
    async (testName: string) => {
      const result = await loadABTestPreview(testName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing AB test ${testName}...` });
          const removeResult = await removeABTestOp(testName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'ab-test-success', testName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-ab-test', testName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadABTestPreview, force, removeABTestOp]
  );

  const handleSelectRuntimeEndpoint = useCallback(
    async (endpointName: string) => {
      const result = await loadRuntimeEndpointPreview(endpointName);
      if (result.ok) {
        if (force) {
          setFlow({ name: 'loading', message: `Removing runtime endpoint ${endpointName}...` });
          const removeResult = await removeRuntimeEndpointOp(endpointName, result.preview);
          if (removeResult.success) {
            setFlow({ name: 'runtime-endpoint-success', endpointName });
          } else {
            setFlow({ name: 'error', message: removeResult.error.message });
          }
        } else {
          setFlow({ name: 'confirm-runtime-endpoint', endpointName, preview: result.preview });
        }
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [loadRuntimeEndpointPreview, force, removeRuntimeEndpointOp]
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
        case 'credential':
          void handleSelectIdentity(initialResourceName);
          break;
        case 'evaluator':
          void handleSelectEvaluator(initialResourceName);
          break;
        case 'online-eval':
          void handleSelectOnlineEval(initialResourceName);
          break;
        case 'policy-engine':
          void handleSelectPolicyEngine(initialResourceName);
          break;
        case 'policy':
          void handleSelectPolicy(initialResourceName);
          break;
        case 'config-bundle':
          void handleSelectConfigBundle(initialResourceName);
          break;
        case 'ab-test':
          void handleSelectABTest(initialResourceName);
          break;
        case 'runtime-endpoint':
          void handleSelectRuntimeEndpoint(initialResourceName);
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
    handleSelectEvaluator,
    handleSelectOnlineEval,
    handleSelectPolicyEngine,
    handleSelectPolicy,
    handleSelectConfigBundle,
    handleSelectABTest,
    handleSelectRuntimeEndpoint,
  ]);

  // Confirm handlers - pass preview for logging
  const handleConfirmAgent = useCallback(
    async (agentName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing agent ${agentName}...` });
      const result = await removeAgentOp(agentName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'agent-success', agentName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
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
      if (result.success) {
        pendingResultRef.current = { name: 'gateway-success', gatewayName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeGatewayOp]
  );

  const handleConfirmGatewayTarget = useCallback(
    async (tool: RemovableGatewayTarget, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing gateway target ${tool.name}...` });
      const result = await removeGatewayTargetOp(tool, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'tool-success', toolName: tool.name, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeGatewayTargetOp]
  );

  const handleConfirmMemory = useCallback(
    async (memoryName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing memory ${memoryName}...` });
      const result = await removeMemoryOp(memoryName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'memory-success', memoryName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
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
      if (result.success) {
        pendingResultRef.current = { name: 'identity-success', identityName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeIdentityOp]
  );

  const handleConfirmEvaluator = useCallback(
    async (evaluatorName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing evaluator ${evaluatorName}...` });
      const result = await removeEvaluatorOp(evaluatorName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'evaluator-success', evaluatorName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeEvaluatorOp]
  );

  const handleConfirmOnlineEval = useCallback(
    async (configName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing online eval config ${configName}...` });
      const result = await removeOnlineEvalOp(configName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'online-eval-success', configName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeOnlineEvalOp]
  );

  const handleConfirmPolicyEngine = useCallback(
    async (engineName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing policy engine ${engineName}...` });
      const result = await removePolicyEngineOp(engineName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'policy-engine-success', engineName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removePolicyEngineOp]
  );

  const handleConfirmPolicy = useCallback(
    async (compositeKey: string, policyName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing policy ${policyName}...` });
      const result = await removePolicyOp(compositeKey, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'policy-success', policyName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removePolicyOp]
  );

  const handleConfirmConfigBundle = useCallback(
    async (bundleName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing configuration bundle ${bundleName}...` });
      const result = await removeConfigBundleOp(bundleName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'config-bundle-success', bundleName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeConfigBundleOp]
  );

  const handleConfirmABTest = useCallback(
    async (testName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing AB test ${testName}...` });
      const result = await removeABTestOp(testName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'ab-test-success', testName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeABTestOp]
  );

  const handleConfirmRuntimeEndpoint = useCallback(
    async (endpointName: string, preview: RemovalPreview) => {
      pendingResultRef.current = null;
      setResultReady(false);
      setFlow({ name: 'loading', message: `Removing runtime endpoint ${endpointName}...` });
      const result = await removeRuntimeEndpointOp(endpointName, preview);
      if (result.success) {
        pendingResultRef.current = { name: 'runtime-endpoint-success', endpointName, logFilePath: result.logFilePath };
      } else {
        pendingResultRef.current = { name: 'error', message: result.error.message };
      }
      setResultReady(true);
    },
    [removeRuntimeEndpointOp]
  );

  const resetAll = useCallback(() => {
    resetPreview();
    resetRemoveAgent();
    resetRemoveGateway();
    resetRemoveGatewayTarget();
    resetRemoveMemory();
    resetRemoveIdentity();
    resetRemoveEvaluator();
    resetRemoveOnlineEval();
    resetRemovePolicyEngine();
    resetRemovePolicy();
    resetRemoveConfigBundle();
    resetRemoveABTest();
    resetRemoveRuntimeEndpoint();
  }, [
    resetPreview,
    resetRemoveAgent,
    resetRemoveGateway,
    resetRemoveGatewayTarget,
    resetRemoveMemory,
    resetRemoveIdentity,
    resetRemoveEvaluator,
    resetRemoveOnlineEval,
    resetRemovePolicyEngine,
    resetRemovePolicy,
    resetRemoveConfigBundle,
    resetRemoveABTest,
    resetRemoveRuntimeEndpoint,
  ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshGateways(),
      refreshTools(),
      refreshMemories(),
      refreshIdentities(),
      refreshEvaluators(),
      refreshOnlineEvals(),
      refreshPolicyEngines(),
      refreshPolicies(),
      refreshConfigBundles(),
      refreshRuntimeEndpoints(),
    ]);
  }, [
    refreshAgents,
    refreshGateways,
    refreshTools,
    refreshMemories,
    refreshIdentities,
    refreshEvaluators,
    refreshOnlineEvals,
    refreshPolicyEngines,
    refreshPolicies,
    refreshConfigBundles,
    refreshRuntimeEndpoints,
  ]);

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
        credentialCount={identities.length}
        evaluatorCount={evaluators.length}
        onlineEvalCount={onlineEvalConfigs.length}
        policyEngineCount={policyEngines.length}
        policyCount={policies.length}
        configBundleCount={configBundles.length}
        abTestCount={abTests.length}
        runtimeEndpointCount={runtimeEndpoints.length}
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

  if (flow.name === 'select-gateway-target') {
    return (
      <RemoveGatewayTargetScreen
        tools={mcpTools}
        onSelect={(tool: RemovableGatewayTarget) => void handleSelectGatewayTarget(tool)}
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

  if (flow.name === 'select-evaluator') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveEvaluatorScreen
        evaluators={evaluators}
        onSelect={(name: string) => void handleSelectEvaluator(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-online-eval') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveOnlineEvalScreen
        configs={onlineEvalConfigs}
        onSelect={(name: string) => void handleSelectOnlineEval(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-policy-engine') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemovePolicyEngineScreen
        policyEngines={policyEngines}
        onSelect={(name: string) => void handleSelectPolicyEngine(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-policy') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemovePolicyScreen
        policies={policies}
        onSelect={(compositeKey: string) => void handleSelectPolicy(compositeKey)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-config-bundle') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveConfigBundleScreen
        configBundles={configBundles}
        onSelect={(name: string) => void handleSelectConfigBundle(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-ab-test') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveABTestScreen
        abTests={abTests}
        onSelect={(name: string) => void handleSelectABTest(name)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'select-runtime-endpoint') {
    if (initialResourceName && isLoading) {
      return null;
    }
    return (
      <RemoveRuntimeEndpointScreen
        endpoints={runtimeEndpoints}
        onSelect={(name: string) => void handleSelectRuntimeEndpoint(name)}
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

  if (flow.name === 'confirm-gateway-target') {
    return (
      <RemoveConfirmScreen
        title={`Remove Gateway Target: ${flow.tool.name}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmGatewayTarget(flow.tool, flow.preview)}
        onCancel={() => setFlow({ name: 'select-gateway-target' })}
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

  if (flow.name === 'confirm-evaluator') {
    return (
      <RemoveConfirmScreen
        title={`Remove Evaluator: ${flow.evaluatorName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmEvaluator(flow.evaluatorName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-evaluator' })}
      />
    );
  }

  if (flow.name === 'confirm-online-eval') {
    return (
      <RemoveConfirmScreen
        title={`Remove Online Eval Config: ${flow.configName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmOnlineEval(flow.configName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-online-eval' })}
      />
    );
  }

  if (flow.name === 'confirm-policy-engine') {
    return (
      <RemoveConfirmScreen
        title={`Remove Policy Engine: ${flow.engineName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmPolicyEngine(flow.engineName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-policy-engine' })}
      />
    );
  }

  if (flow.name === 'confirm-policy') {
    return (
      <RemoveConfirmScreen
        title={`Remove Policy: ${flow.policyName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmPolicy(flow.compositeKey, flow.policyName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-policy' })}
      />
    );
  }

  if (flow.name === 'confirm-config-bundle') {
    return (
      <RemoveConfirmScreen
        title={`Remove Configuration Bundle: ${flow.bundleName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmConfigBundle(flow.bundleName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-config-bundle' })}
      />
    );
  }

  if (flow.name === 'confirm-ab-test') {
    return (
      <RemoveConfirmScreen
        title={`Remove AB Test: ${flow.testName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmABTest(flow.testName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-ab-test' })}
      />
    );
  }

  if (flow.name === 'confirm-runtime-endpoint') {
    return (
      <RemoveConfirmScreen
        title={`Remove Runtime Endpoint: ${flow.endpointName}`}
        preview={flow.preview}
        onConfirm={() => void handleConfirmRuntimeEndpoint(flow.endpointName, flow.preview)}
        onCancel={() => setFlow({ name: 'select-runtime-endpoint' })}
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
        detail="Gateway removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
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
        message={`Removed gateway target: ${flow.toolName}`}
        detail="Gateway target removed. Deploy with `agentcore deploy` to apply changes."
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
        message={`Removed credential: ${flow.identityName}`}
        detail="Credential removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'evaluator-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed evaluator: ${flow.evaluatorName}`}
        detail="Evaluator removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'online-eval-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed online eval config: ${flow.configName}`}
        detail="Online eval config removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'policy-engine-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed policy engine: ${flow.engineName}`}
        detail="Policy engine removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'policy-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed policy: ${flow.policyName}`}
        detail="Policy removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'config-bundle-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed configuration bundle: ${flow.bundleName}`}
        detail="Configuration bundle removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'ab-test-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed AB test: ${flow.testName}`}
        detail="AB test removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
        logFilePath={flow.logFilePath}
        onRemoveAnother={() => {
          resetAll();
          void refreshAll().then(() => setFlow({ name: 'select' }));
        }}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'runtime-endpoint-success') {
    return (
      <RemoveSuccessScreen
        isInteractive={isInteractive}
        message={`Removed runtime endpoint: ${flow.endpointName}`}
        detail="Runtime endpoint removed from agentcore.json. Deploy with `agentcore deploy` to apply changes."
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
      detail={'message' in flow ? flow.message : 'Unknown error'}
      onBack={() => {
        resetAll();
        setFlow({ name: 'select' });
      }}
      onExit={onExit}
    />
  );
}
