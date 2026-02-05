import type { Memory } from '../../../schema';
import { getAvailableAgents } from '../../operations/attach';
import { type CreateMemoryConfig, createMemory, getAllMemoryNames } from '../../operations/memory/create-memory';
import { useCallback, useEffect, useState } from 'react';

interface CreateStatus<T> {
  state: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  result?: T;
}

export function useCreateMemory() {
  const [status, setStatus] = useState<CreateStatus<Memory>>({ state: 'idle' });

  const create = useCallback(async (config: CreateMemoryConfig) => {
    setStatus({ state: 'loading' });
    try {
      const result = await createMemory(config);
      setStatus({ state: 'success', result });
      return { ok: true as const, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create memory.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createMemory: create, reset };
}

export function useExistingMemoryNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void getAllMemoryNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getAllMemoryNames();
    setNames(result);
  }, []);

  return { names, refresh };
}

export function useAvailableAgentsForMemory() {
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    void getAvailableAgents().then(setAgents);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getAvailableAgents();
    setAgents(result);
  }, []);

  return { agents, refresh };
}
