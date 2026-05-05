import type { Result } from '../../../lib/result';
import type { ResourceType } from '../../commands/remove/types';
import { RemoveLogger } from '../../logging';
import type { RemovableGatewayTarget, RemovalPreview } from '../../operations/remove';
import type { RemovableCredential } from '../../primitives/CredentialPrimitive';
import type { RemovableMemory } from '../../primitives/MemoryPrimitive';
import type { RemovablePolicyResource } from '../../primitives/PolicyPrimitive';
import type { RemovableRuntimeEndpoint } from '../../primitives/RuntimeEndpointPrimitive';
import {
  abTestPrimitive,
  agentPrimitive,
  configBundlePrimitive,
  credentialPrimitive,
  evaluatorPrimitive,
  gatewayPrimitive,
  gatewayTargetPrimitive,
  memoryPrimitive,
  onlineEvalConfigPrimitive,
  policyEnginePrimitive,
  policyPrimitive,
  runtimeEndpointPrimitive,
} from '../../primitives/registry';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import type { SubCommand } from '../../telemetry/schemas/command-run.js';
import { useCallback, useEffect, useRef, useState } from 'react';

// Re-export types for consumers
export type {
  RemovableMemory,
  RemovableCredential as RemovableIdentity,
  RemovableGatewayTarget,
  RemovablePolicyResource,
  RemovableRuntimeEndpoint,
};

// ============================================================================
// Generic Hooks
// ============================================================================

/**
 * Generic hook for loading removable resources from a primitive.
 * All useRemovable* hooks delegate to this.
 */
function useRemovableResources<T>(loader: () => Promise<T[]>) {
  // Ref captures the initial loader; all callers pass stable functions referencing singletons
  const loaderRef = useRef(loader);

  const [items, setItems] = useState<T[] | null>(null);

  useEffect(() => {
    void loaderRef.current().then(setItems);
  }, []);

  const refresh = useCallback(async () => {
    setItems(await loaderRef.current());
  }, []);

  return { items: items ?? [], isLoading: items === null, refresh };
}

/**
 * Generic hook for removing a resource with logging.
 * All useRemove* hooks delegate to this.
 */
function useRemoveResource<TIdentifier>(
  removeFn: (id: TIdentifier) => Promise<Result>,
  resourceType: ResourceType,
  getResourceName: (id: TIdentifier) => string
) {
  // Refs capture initial values; all callers pass stable functions referencing singletons
  const removeFnRef = useRef(removeFn);
  const resourceTypeRef = useRef(resourceType);
  const getNameRef = useRef(getResourceName);

  const [state, setState] = useState<RemovalState>({ isLoading: false, result: null });
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  const remove = useCallback(async (id: TIdentifier, preview?: RemovalPreview): Promise<RemoveResult> => {
    setState({ isLoading: true, result: null });
    const result = await withCommandRunTelemetry<SubCommand<'remove', ResourceType>, Result>(
      `remove.${resourceTypeRef.current}`,
      {},
      () => removeFnRef.current(id)
    );
    setState({ isLoading: false, result });

    let logPath: string | undefined;
    if (preview) {
      const logger = new RemoveLogger({
        resourceType: resourceTypeRef.current,
        resourceName: getNameRef.current(id),
      });
      logger.logRemoval(preview, result.success, result.success ? undefined : result.error?.message);
      logPath = logger.getAbsoluteLogPath();
      setLogFilePath(logPath);
    }

    return { ...result, logFilePath: logPath };
  }, []);

  const reset = useCallback(() => {
    setState({ isLoading: false, result: null });
    setLogFilePath(null);
  }, []);

  return { ...state, logFilePath, remove, reset };
}

// ============================================================================
// Removable Resources Hooks
// ============================================================================

export function useRemovableAgents() {
  const { items: agents, ...rest } = useRemovableResources(() =>
    agentPrimitive.getRemovable().then(r => r.map(a => a.name))
  );
  return { agents, ...rest };
}

export function useRemovableGateways() {
  const { items: gateways, ...rest } = useRemovableResources(() =>
    gatewayPrimitive.getRemovable().then(r => r.map(g => g.name))
  );
  return { gateways, ...rest };
}

export function useRemovableGatewayTargets() {
  const { items: tools, ...rest } = useRemovableResources(() => gatewayTargetPrimitive.getRemovable());
  return { tools, ...rest };
}

export function useRemovableMemories() {
  const { items: memories, ...rest } = useRemovableResources(() => memoryPrimitive.getRemovable());
  return { memories, ...rest };
}

export function useRemovableIdentities() {
  const { items: identities, ...rest } = useRemovableResources(() => credentialPrimitive.getRemovable());
  return { identities, ...rest };
}

export function useRemovableEvaluators() {
  const { items: evaluators, ...rest } = useRemovableResources(() => evaluatorPrimitive.getRemovable());
  return { evaluators, ...rest };
}

export function useRemovableOnlineEvalConfigs() {
  const { items: onlineEvalConfigs, ...rest } = useRemovableResources(() => onlineEvalConfigPrimitive.getRemovable());
  return { onlineEvalConfigs, ...rest };
}

export function useRemovablePolicyEngines() {
  const { items: policyEngines, ...rest } = useRemovableResources(() => policyEnginePrimitive.getRemovable());
  return { policyEngines, ...rest };
}

export function useRemovablePolicies() {
  const { items: policies, ...rest } = useRemovableResources(() => policyPrimitive.getRemovable());
  return { policies, ...rest };
}

export function useRemovableConfigBundles() {
  const { items: configBundles, ...rest } = useRemovableResources(() => configBundlePrimitive.getRemovable());
  return { configBundles, ...rest };
}

export function useRemovableABTests() {
  const { items: abTests, ...rest } = useRemovableResources(() => abTestPrimitive.getRemovable());
  return { abTests, ...rest };
}

export function useRemoveABTest() {
  return useRemoveResource(
    (name: string) => abTestPrimitive.remove(name),
    'ab-test',
    name => name
  );
}

export function useRemovableRuntimeEndpoints() {
  const { items: endpoints, ...rest } = useRemovableResources<RemovableRuntimeEndpoint>(() =>
    runtimeEndpointPrimitive.getRemovable()
  );
  return { endpoints, ...rest };
}

// ============================================================================
// Preview Hook
// ============================================================================

interface PreviewState {
  isLoading: boolean;
  preview: RemovalPreview | null;
  error: string | null;
}

type PreviewResult = { ok: true; preview: RemovalPreview } | { ok: false; error: string };

export function useRemovalPreview() {
  const [state, setState] = useState<PreviewState>({
    isLoading: false,
    preview: null,
    error: null,
  });

  const loadPreview = useCallback(
    async <T>(previewFn: (id: T) => Promise<RemovalPreview>, id: T): Promise<PreviewResult> => {
      setState({ isLoading: true, preview: null, error: null });
      try {
        const preview = await previewFn(id);
        setState({ isLoading: false, preview, error: null });
        return { ok: true, preview };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load preview';
        setState({ isLoading: false, preview: null, error: message });
        return { ok: false, error: message };
      }
    },
    []
  );

  const loadAgentPreview = useCallback(
    (name: string) => loadPreview(n => agentPrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadGatewayPreview = useCallback(
    (name: string) => loadPreview(n => gatewayPrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadGatewayTargetPreview = useCallback(
    (tool: RemovableGatewayTarget) => loadPreview(t => gatewayTargetPrimitive.previewRemoveGatewayTarget(t), tool),
    [loadPreview]
  );
  const loadMemoryPreview = useCallback(
    (name: string) => loadPreview(n => memoryPrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadIdentityPreview = useCallback(
    (name: string) => loadPreview(n => credentialPrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadEvaluatorPreview = useCallback(
    (name: string) => loadPreview(n => evaluatorPrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadOnlineEvalPreview = useCallback(
    (name: string) => loadPreview(n => onlineEvalConfigPrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadPolicyEnginePreview = useCallback(
    (name: string) => loadPreview(n => policyEnginePrimitive.previewRemove(n), name),
    [loadPreview]
  );
  const loadPolicyPreview = useCallback(
    (compositeKey: string) => loadPreview(k => policyPrimitive.previewRemove(k), compositeKey),
    [loadPreview]
  );
  const loadConfigBundlePreview = useCallback(
    (name: string) => loadPreview(n => configBundlePrimitive.previewRemove(n), name),
    [loadPreview]
  );

  const loadABTestPreview = useCallback(
    (name: string) => loadPreview(n => abTestPrimitive.previewRemove(n), name),
    [loadPreview]
  );

  const loadRuntimeEndpointPreview = useCallback(
    (name: string) => loadPreview(n => runtimeEndpointPrimitive.previewRemove(n), name),
    [loadPreview]
  );

  const reset = useCallback(() => {
    setState({ isLoading: false, preview: null, error: null });
  }, []);

  return {
    ...state,
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
    reset,
  };
}

// ============================================================================
// Removal Hooks
// ============================================================================

interface RemovalState {
  isLoading: boolean;
  result: Result | null;
}

type RemoveResult = Result & { logFilePath?: string };

export function useRemoveAgent() {
  return useRemoveResource(
    (name: string) => agentPrimitive.remove(name),
    'agent',
    name => name
  );
}

export function useRemoveGateway() {
  return useRemoveResource(
    (name: string) => gatewayPrimitive.remove(name),
    'gateway',
    name => name
  );
}

export function useRemoveGatewayTarget() {
  return useRemoveResource(
    (tool: RemovableGatewayTarget) => gatewayTargetPrimitive.removeGatewayTarget(tool),
    'gateway-target',
    tool => tool.name
  );
}

export function useRemoveMemory() {
  return useRemoveResource(
    (name: string) => memoryPrimitive.remove(name),
    'memory',
    name => name
  );
}

export function useRemoveIdentity() {
  return useRemoveResource(
    (name: string) => credentialPrimitive.remove(name),
    'credential',
    name => name
  );
}

export function useRemoveEvaluator() {
  return useRemoveResource(
    (name: string) => evaluatorPrimitive.remove(name),
    'evaluator',
    name => name
  );
}

export function useRemovePolicyEngine() {
  return useRemoveResource(
    (name: string) => policyEnginePrimitive.remove(name),
    'policy-engine',
    name => name
  );
}

export function useRemoveOnlineEvalConfig() {
  return useRemoveResource(
    (name: string) => onlineEvalConfigPrimitive.remove(name),
    'online-eval',
    name => name
  );
}

export function useRemovePolicy() {
  return useRemoveResource(
    (compositeKey: string) => policyPrimitive.remove(compositeKey),
    'policy',
    k => k
  );
}

export function useRemoveConfigBundle() {
  return useRemoveResource(
    (name: string) => configBundlePrimitive.remove(name),
    'config-bundle',
    name => name
  );
}

export function useRemoveRuntimeEndpoint() {
  return useRemoveResource(
    (name: string) => runtimeEndpointPrimitive.remove(name),
    'runtime-endpoint',
    name => name
  );
}
