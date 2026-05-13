import { configBundlePrimitive } from '../../primitives/registry';
import { useCallback, useEffect, useState } from 'react';

interface CreateConfigBundleConfig {
  name: string;
  description?: string;
  components: Record<string, { configuration: Record<string, unknown> }>;
  branchName?: string;
  commitMessage?: string;
}

export function useCreateConfigBundle() {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'success' | 'error'; error?: string }>({
    state: 'idle',
  });

  const create = useCallback(async (config: CreateConfigBundleConfig) => {
    setStatus({ state: 'loading' });
    try {
      const addResult = await configBundlePrimitive.add({
        name: config.name,
        description: config.description,
        components: config.components,
        branchName: config.branchName,
        commitMessage: config.commitMessage,
      });
      if (!addResult.success) {
        throw new Error(addResult.error?.message ?? 'Failed to create configuration bundle');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, bundleName: config.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create configuration bundle.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createConfigBundle: create, reset };
}

export function useExistingConfigBundleNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void configBundlePrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await configBundlePrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}
