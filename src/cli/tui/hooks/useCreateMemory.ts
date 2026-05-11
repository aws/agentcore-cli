import { ConfigIO } from '../../../lib';
import type { Memory } from '../../../schema';
import { getAvailableAgents } from '../../operations/attach';
import { memoryPrimitive } from '../../primitives/registry';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { useCallback, useEffect, useState } from 'react';

interface CreateMemoryConfig {
  name: string;
  eventExpiryDuration: number;
  strategies: { type: string }[];
  streaming?: { dataStreamArn: string; contentLevel: string };
}

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
      const strategiesStr = config.strategies.map(s => s.type).join(',');
      const strategyList = strategiesStr ? strategiesStr.split(',').map(s => s.trim().toUpperCase()) : [];
      const addResult = await withCommandRunTelemetry(
        'add.memory',
        {
          strategy_count: strategyList.length,
          strategy_semantic: strategyList.includes('SEMANTIC'),
          strategy_summarization: strategyList.includes('SUMMARIZATION'),
          strategy_user_preference: strategyList.includes('USER_PREFERENCE'),
          strategy_episodic: strategyList.includes('EPISODIC'),
        },
        () =>
          memoryPrimitive.add({
            name: config.name,
            expiry: config.eventExpiryDuration,
            strategies: strategiesStr || undefined,
            dataStreamArn: config.streaming?.dataStreamArn,
            contentLevel: config.streaming?.contentLevel,
          })
      );
      if (!addResult.success) {
        throw new Error(addResult.error ?? 'Failed to create memory');
      }
      // Read back the memory object
      const configIO = new ConfigIO();
      const project = await configIO.readProjectSpec();
      const memory = project.memories.find(m => m.name === config.name);
      if (!memory) {
        throw new Error(`Memory "${config.name}" not found after creation`);
      }
      setStatus({ state: 'success', result: memory });
      return { ok: true as const, result: memory };
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
    void memoryPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await memoryPrimitive.getAllNames();
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
