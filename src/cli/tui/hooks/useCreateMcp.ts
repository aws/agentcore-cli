import { agentPrimitive, gatewayPrimitive, gatewayTargetPrimitive } from '../../primitives/registry';
import type { AddGatewayConfig } from '../screens/mcp/types';
import { useCallback, useEffect, useState } from 'react';

interface CreateGatewayResult {
  name: string;
}

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
      const addResult = await gatewayPrimitive.add({
        name: config.name,
        description: config.description,
        authorizerType: config.authorizerType,
        discoveryUrl: config.jwtConfig?.discoveryUrl,
        allowedAudience: config.jwtConfig?.allowedAudience?.join(','),
        allowedClients: config.jwtConfig?.allowedClients?.join(','),
        allowedScopes: config.jwtConfig?.allowedScopes?.join(','),
        agentClientId: config.jwtConfig?.agentClientId,
        agentClientSecret: config.jwtConfig?.agentClientSecret,
      });
      if (!addResult.success) {
        throw new Error(addResult.error ?? 'Failed to create gateway');
      }
      const result: CreateGatewayResult = { name: config.name };
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

export function useExistingGateways() {
  const [gateways, setGateways] = useState<string[]>([]);

  useEffect(() => {
    async function load() {
      const result = await gatewayPrimitive.getExistingGateways();
      setGateways(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await gatewayPrimitive.getExistingGateways();
    setGateways(result);
  }, []);

  return { gateways, refresh };
}

export function useAvailableAgents() {
  const [agents, setAgents] = useState<string[] | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const removable = await agentPrimitive.getRemovable();
        setAgents(removable.map(a => a.name));
      } catch {
        setAgents([]);
      }
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const removable = await agentPrimitive.getRemovable();
      setAgents(removable.map(a => a.name));
    } catch {
      setAgents([]);
    }
  }, []);

  return { agents: agents ?? [], isLoading: agents === null, refresh };
}

export function useExistingToolNames() {
  const [toolNames, setToolNames] = useState<string[]>([]);

  useEffect(() => {
    async function load() {
      const result = await gatewayTargetPrimitive.getExistingToolNames();
      setToolNames(result);
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await gatewayTargetPrimitive.getExistingToolNames();
    setToolNames(result);
  }, []);

  return { toolNames, refresh };
}

export function useUnassignedTargets() {
  const [targets, setTargets] = useState<string[]>([]);

  useEffect(() => {
    async function load() {
      const result = await gatewayPrimitive.getUnassignedTargets();
      setTargets(result.map(t => t.name));
    }
    void load();
  }, []);

  const refresh = useCallback(async () => {
    const result = await gatewayPrimitive.getUnassignedTargets();
    setTargets(result.map(t => t.name));
  }, []);

  return { targets, refresh };
}
