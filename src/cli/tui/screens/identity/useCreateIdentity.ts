import { ConfigIO } from '../../../../lib';
import type { Credential } from '../../../../schema';
import type { AddCredentialOptions } from '../../../primitives/CredentialPrimitive';
import { credentialPrimitive } from '../../../primitives/registry';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { useCallback, useEffect, useState } from 'react';

interface CreateStatus<T> {
  state: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  result?: T;
}

export function useCreateIdentity() {
  const [status, setStatus] = useState<CreateStatus<Credential>>({ state: 'idle' });

  const create = useCallback(async (config: AddCredentialOptions) => {
    setStatus({ state: 'loading' });
    try {
      const result = await withCommandRunTelemetry(
        'add.credential',
        {
          credential_type: config.authorizerType === 'OAuthCredentialProvider' ? 'oauth' : 'api-key',
        },
        () => credentialPrimitive.add(config)
      );
      if (!result.success) {
        throw new Error(result.error?.message ?? 'Failed to create credential');
      }
      // Read back the credential object
      const configIO = new ConfigIO();
      const project = await configIO.readProjectSpec();
      const credential = project.credentials.find(c => c.name === config.name);
      if (!credential) {
        throw new Error(`Credential "${config.name}" not found after creation`);
      }
      setStatus({ state: 'success', result: credential });
      return { ok: true as const, result: credential };
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
    void credentialPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await credentialPrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}

export function useExistingCredentials() {
  const [credentials, setCredentials] = useState<Credential[]>([]);

  useEffect(() => {
    void credentialPrimitive.getAllCredentials().then(setCredentials);
  }, []);

  const refresh = useCallback(async () => {
    const result = await credentialPrimitive.getAllCredentials();
    setCredentials(result);
  }, []);

  return { credentials, refresh };
}

// Alias for old name
export const useExistingIdentityNames = useExistingCredentialNames;
