import type { CreateGatewayResult, CreateToolResult } from '../../operations/mcp/create-mcp';
import {
  createGatewayFromWizard,
  createToolFromWizard,
  getAvailableAgents,
  getExistingGateways,
  getExistingToolNames,
  getUnassignedTargets,
} from '../../operations/mcp/create-mcp';
import type { AddGatewayConfig, AddGatewayTargetConfig } from '../screens/mcp/types';
import { useCallback, useEffect, useState } from 'react';

interface CreateStatus<T> {
  state: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  result?: T;
}

export function useCreateGateway() {
  const [status, setStatus] = useState<CreateStatus<CreateGatewayResult>>({ state: 'idle' });

  const createGateway = useCallback(async (config: AddGatewayConfig) => {
    setStatus({ state: 'loading' });
    try {
      const result = await createGatewayFromWizard(config);
      setStatus({ state: 'success', result });
      return { ok: true as const, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create gateway.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createGateway, reset };
}

export function useCreateGatewayTarget() {
  const [status, setStatus] = useState<CreateStatus<CreateToolResult>>({ state: 'idle' });

  const createTool = useCallback(async (config: AddGatewayTargetConfig) => {
    setStatus({ state: 'loading' });
    try {
      const result = await createToolFromWizard(config);
      setStatus({ state: 'success', result });
      return { ok: true as const, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create gateway target.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createTool, reset };
}

export function useExistingGateways() {
  const [gateways, setGateways] = useState<string[]>([]);

  useEffect(() => {
    async function load() {
      const result = await getExistingGateways();
      setGateways(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getExistingGateways();
    setGateways(result);
  }, []);

  return { gateways, refresh };
}

export function useAvailableAgents() {
  const [agents, setAgents] = useState<string[] | null>(null);

  useEffect(() => {
    async function load() {
      const result = await getAvailableAgents();
      setAgents(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getAvailableAgents();
    setAgents(result);
  }, []);

  return { agents: agents ?? [], isLoading: agents === null, refresh };
}

export function useExistingToolNames() {
  const [toolNames, setToolNames] = useState<string[]>([]);

  useEffect(() => {
    async function load() {
      const result = await getExistingToolNames();
      setToolNames(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getExistingToolNames();
    setToolNames(result);
  }, []);

  return { toolNames, refresh };
}

export function useUnassignedTargets() {
  const [targets, setTargets] = useState<string[]>([]);

  useEffect(() => {
    async function load() {
      const result = await getUnassignedTargets();
      setTargets(result.map(t => t.name));
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await getUnassignedTargets();
    setTargets(result.map(t => t.name));
  }, []);

  return { targets, refresh };
}
