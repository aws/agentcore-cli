import type { Credential } from '../../../../schema';
import {
  type CreateCredentialConfig,
  createCredential,
  getAllCredentialNames,
} from '../../../operations/identity/create-identity';
import { useCallback, useEffect, useState } from 'react';

interface CreateStatus<T> {
  state: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  result?: T;
}

export function useCreateIdentity() {
  const [status, setStatus] = useState<CreateStatus<Credential>>({ state: 'idle' });

  const create = useCallback(async (config: CreateCredentialConfig) => {
    setStatus({ state: 'loading' });
    try {
      const result = await createCredential(config);
      setStatus({ state: 'success', result });
      return { ok: true as const, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create credential.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createIdentity: create, reset };
}

export function useExistingCredentialNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void getAllCredentialNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await getAllCredentialNames();
    setNames(result);
  }, []);

  return { names, refresh };
}

// Alias for old name
export const useExistingIdentityNames = useExistingCredentialNames;
