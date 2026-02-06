import {
  bindMcpRuntimeToAgent,
  getAvailableAgents,
  getCredentials,
  getGateways,
  getMcpRuntimeTools,
  getMemories,
} from '../../operations/attach';
import type { BindMcpRuntimeConfig } from '../../operations/attach';
import { useCallback, useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Data Loading Hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useAgents() {
  const [agents, setAgents] = useState<string[] | null>(null);

  useEffect(() => {
    void getAvailableAgents().then(setAgents);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getAvailableAgents();
    setAgents(result);
  }, []);

  return { agents: agents ?? [], isLoading: agents === null, refresh };
}

export function useMemories() {
  const [memories, setMemories] = useState<string[]>([]);

  useEffect(() => {
    void getMemories().then(setMemories);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getMemories();
    setMemories(result);
  }, []);

  return { memories, refresh };
}

export function useCredentials() {
  const [credentials, setCredentials] = useState<string[]>([]);

  useEffect(() => {
    void getCredentials().then(setCredentials);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getCredentials();
    setCredentials(result);
  }, []);

  return { credentials, refresh };
}

export function useMcpRuntimeTools() {
  const [tools, setTools] = useState<string[]>([]);

  useEffect(() => {
    void getMcpRuntimeTools().then(setTools);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getMcpRuntimeTools();
    setTools(result);
  }, []);

  return { tools, refresh };
}

export function useGateways() {
  const [gateways, setGateways] = useState<string[]>([]);

  useEffect(() => {
    void getGateways().then(setGateways);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getGateways();
    setGateways(result);
  }, []);

  return { gateways, refresh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy hooks (stubs for TUI screens, v2 doesn't use attach pattern)
// ─────────────────────────────────────────────────────────────────────────────

// Alias for old hook name
export const useOwnedMemories = useMemories;
export const useOwnedIdentities = useCredentials;

// Stub attach hooks (no-op in v2, resources have implicit access)
export function useAttachAgent() {
  return {
    attach: async () => ({ ok: true as const }),
    isLoading: false,
    reset: () => {},
  };
}

export function useAttachMemory() {
  return {
    attach: async () => ({ ok: true as const }),
    isLoading: false,
    reset: () => {},
  };
}

export function useAttachIdentity() {
  return {
    attach: async () => ({ ok: true as const }),
    isLoading: false,
    reset: () => {},
  };
}

export function useAttachGateway() {
  return {
    attach: async () => ({ ok: true as const }),
    isLoading: false,
    reset: () => {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Binding Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useBindMcpRuntime() {
  const [isLoading, setIsLoading] = useState(false);

  const bind = useCallback(async (mcpRuntimeName: string, config: BindMcpRuntimeConfig) => {
    setIsLoading(true);
    try {
      await bindMcpRuntimeToAgent(mcpRuntimeName, config);
      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to bind agent to MCP runtime.';
      return { ok: false as const, error: message };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = useCallback(() => setIsLoading(false), []);

  return { bind, isLoading, reset };
}
