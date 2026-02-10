import { RemoveLogger } from '../../logging';
import type {
  RemovableIdentity,
  RemovableMcpTool,
  RemovableMemory,
  RemovalPreview,
  RemovalResult,
} from '../../operations/remove';
import {
  getRemovableAgents,
  getRemovableGateways,
  getRemovableIdentities,
  getRemovableMcpTools,
  getRemovableMemories,
  previewRemoveAgent,
  previewRemoveGateway,
  previewRemoveIdentity,
  previewRemoveMcpTool,
  previewRemoveMemory,
  removeAgent,
  removeGateway,
  removeIdentity,
  removeMcpTool,
  removeMemory,
} from '../../operations/remove';
import { useCallback, useEffect, useState } from 'react';

// ============================================================================
// Removable Resources Hooks
// ============================================================================

export function useRemovableAgents() {
  const [agents, setAgents] = useState<string[] | null>(null);

  useEffect(() => {
    async function load() {
      const result = await getRemovableAgents();
      setAgents(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getRemovableAgents();
    setAgents(result);
  }, []);

  return { agents: agents ?? [], isLoading: agents === null, refresh };
}

export function useRemovableGateways() {
  const [gateways, setGateways] = useState<string[] | null>(null);

  useEffect(() => {
    async function load() {
      const result = await getRemovableGateways();
      setGateways(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getRemovableGateways();
    setGateways(result);
  }, []);

  return { gateways: gateways ?? [], isLoading: gateways === null, refresh };
}

export function useRemovableMcpTools() {
  const [tools, setTools] = useState<RemovableMcpTool[] | null>(null);

  useEffect(() => {
    async function load() {
      const result = await getRemovableMcpTools();
      setTools(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getRemovableMcpTools();
    setTools(result);
  }, []);

  return { tools: tools ?? [], isLoading: tools === null, refresh };
}

export function useRemovableMemories() {
  const [memories, setMemories] = useState<RemovableMemory[] | null>(null);

  useEffect(() => {
    async function load() {
      const result = await getRemovableMemories();
      setMemories(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getRemovableMemories();
    setMemories(result);
  }, []);

  return { memories: memories ?? [], isLoading: memories === null, refresh };
}

export function useRemovableIdentities() {
  const [identities, setIdentities] = useState<RemovableIdentity[] | null>(null);

  useEffect(() => {
    async function load() {
      const result = await getRemovableIdentities();
      setIdentities(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getRemovableIdentities();
    setIdentities(result);
  }, []);

  return { identities: identities ?? [], isLoading: identities === null, refresh };
}

// ============================================================================
// Preview Hooks
// ============================================================================

interface PreviewState {
  isLoading: boolean;
  preview: RemovalPreview | null;
  error: string | null;
}

export function useRemovalPreview() {
  const [state, setState] = useState<PreviewState>({
    isLoading: false,
    preview: null,
    error: null,
  });

  const loadAgentPreview = useCallback(async (agentName: string) => {
    setState({ isLoading: true, preview: null, error: null });
    try {
      const preview = await previewRemoveAgent(agentName);
      setState({ isLoading: false, preview, error: null });
      return { ok: true as const, preview };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preview';
      setState({ isLoading: false, preview: null, error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const loadGatewayPreview = useCallback(async (gatewayName: string) => {
    setState({ isLoading: true, preview: null, error: null });
    try {
      const preview = await previewRemoveGateway(gatewayName);
      setState({ isLoading: false, preview, error: null });
      return { ok: true as const, preview };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preview';
      setState({ isLoading: false, preview: null, error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const loadMcpToolPreview = useCallback(async (tool: RemovableMcpTool) => {
    setState({ isLoading: true, preview: null, error: null });
    try {
      const preview = await previewRemoveMcpTool(tool);
      setState({ isLoading: false, preview, error: null });
      return { ok: true as const, preview };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preview';
      setState({ isLoading: false, preview: null, error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const loadMemoryPreview = useCallback(async (memoryName: string) => {
    setState({ isLoading: true, preview: null, error: null });
    try {
      const preview = await previewRemoveMemory(memoryName);
      setState({ isLoading: false, preview, error: null });
      return { ok: true as const, preview };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preview';
      setState({ isLoading: false, preview: null, error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const loadIdentityPreview = useCallback(async (identityName: string) => {
    setState({ isLoading: true, preview: null, error: null });
    try {
      const preview = await previewRemoveIdentity(identityName);
      setState({ isLoading: false, preview, error: null });
      return { ok: true as const, preview };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load preview';
      setState({ isLoading: false, preview: null, error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setState({ isLoading: false, preview: null, error: null });
  }, []);

  return {
    ...state,
    loadAgentPreview,
    loadGatewayPreview,
    loadMcpToolPreview,
    loadMemoryPreview,
    loadIdentityPreview,
    reset,
  };
}

// ============================================================================
// Removal Hooks
// ============================================================================

interface RemovalState {
  isLoading: boolean;
  result: RemovalResult | null;
}

type RemoveResult = RemovalResult & { logFilePath?: string };

export function useRemoveAgent() {
  const [state, setState] = useState<RemovalState>({ isLoading: false, result: null });
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  const remove = useCallback(async (agentName: string, preview?: RemovalPreview): Promise<RemoveResult> => {
    setState({ isLoading: true, result: null });
    const result = await removeAgent(agentName);
    setState({ isLoading: false, result });

    // Log the removal if preview is provided
    let logPath: string | undefined;
    if (preview) {
      const logger = new RemoveLogger({ resourceType: 'agent', resourceName: agentName });
      logger.logRemoval(preview, result.ok, result.ok ? undefined : result.error);
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

export function useRemoveGateway() {
  const [state, setState] = useState<RemovalState>({ isLoading: false, result: null });
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  const remove = useCallback(async (gatewayName: string, preview?: RemovalPreview): Promise<RemoveResult> => {
    setState({ isLoading: true, result: null });
    const result = await removeGateway(gatewayName);
    setState({ isLoading: false, result });

    let logPath: string | undefined;
    if (preview) {
      const logger = new RemoveLogger({ resourceType: 'gateway', resourceName: gatewayName });
      logger.logRemoval(preview, result.ok, result.ok ? undefined : result.error);
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

export function useRemoveMcpTool() {
  const [state, setState] = useState<RemovalState>({ isLoading: false, result: null });
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  const remove = useCallback(async (tool: RemovableMcpTool, preview?: RemovalPreview): Promise<RemoveResult> => {
    setState({ isLoading: true, result: null });
    const result = await removeMcpTool(tool);
    setState({ isLoading: false, result });

    let logPath: string | undefined;
    if (preview) {
      const logger = new RemoveLogger({ resourceType: 'mcp-tool', resourceName: tool.name });
      logger.logRemoval(preview, result.ok, result.ok ? undefined : result.error);
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

export function useRemoveMemory() {
  const [state, setState] = useState<RemovalState>({ isLoading: false, result: null });
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  const remove = useCallback(async (memoryName: string, preview?: RemovalPreview): Promise<RemoveResult> => {
    setState({ isLoading: true, result: null });
    const result = await removeMemory(memoryName);
    setState({ isLoading: false, result });

    let logPath: string | undefined;
    if (preview) {
      const logger = new RemoveLogger({ resourceType: 'memory', resourceName: memoryName });
      logger.logRemoval(preview, result.ok, result.ok ? undefined : result.error);
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

export function useRemoveIdentity() {
  const [state, setState] = useState<RemovalState>({ isLoading: false, result: null });
  const [logFilePath, setLogFilePath] = useState<string | null>(null);

  const remove = useCallback(async (identityName: string, preview?: RemovalPreview): Promise<RemoveResult> => {
    setState({ isLoading: true, result: null });
    const result = await removeIdentity(identityName);
    setState({ isLoading: false, result });

    let logPath: string | undefined;
    if (preview) {
      const logger = new RemoveLogger({ resourceType: 'identity', resourceName: identityName });
      logger.logRemoval(preview, result.ok, result.ok ? undefined : result.error);
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
