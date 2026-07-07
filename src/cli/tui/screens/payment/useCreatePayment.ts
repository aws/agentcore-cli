import { ConfigIO } from '../../../../lib';
import type { PaymentManager } from '../../../../schema';
import type { AddPaymentConnectorOptions } from '../../../primitives/PaymentConnectorPrimitive';
import type { AddPaymentManagerOptions } from '../../../primitives/PaymentManagerPrimitive';
import { paymentConnectorPrimitive, paymentManagerPrimitive } from '../../../primitives/registry';
import { useCallback, useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Manager creation hook
// ─────────────────────────────────────────────────────────────────────────────

interface CreateStatus<T> {
  state: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  result?: T;
}

export function useCreatePayment() {
  const [status, setStatus] = useState<CreateStatus<PaymentManager>>({ state: 'idle' });

  const create = useCallback(async (config: AddPaymentManagerOptions) => {
    setStatus({ state: 'loading' });
    try {
      const result = await paymentManagerPrimitive.add(config);
      if (!result.success) {
        throw result.error ?? new Error('Failed to create payment manager');
      }
      const configIO = new ConfigIO();
      const project = await configIO.readProjectSpec();
      const manager = (project.payments ?? []).find(p => p.name === config.name);
      if (!manager) {
        throw new Error(`Payment manager "${config.name}" not found after creation`);
      }
      setStatus({ state: 'success', result: manager });
      return { ok: true as const, result: manager };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create payment manager.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createPayment: create, reset };
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector creation hook
// ─────────────────────────────────────────────────────────────────────────────

export function useCreatePaymentConnector() {
  const [status, setStatus] = useState<CreateStatus<{ connectorName: string; managerName: string }>>({
    state: 'idle',
  });

  const create = useCallback(async (config: AddPaymentConnectorOptions) => {
    setStatus({ state: 'loading' });
    try {
      const result = await paymentConnectorPrimitive.add(config);
      if (!result.success) {
        throw result.error ?? new Error('Failed to create payment connector');
      }
      setStatus({
        state: 'success',
        result: { connectorName: result.connectorName, managerName: result.managerName },
      });
      return {
        ok: true as const,
        connectorName: result.connectorName,
        managerName: result.managerName,
        credentialName: result.credentialName,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create payment connector.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createConnector: create, reset };
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing names hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useExistingPaymentNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void paymentManagerPrimitive.getRemovable().then(items => setNames(items.map(i => i.name)));
  }, []);

  const refresh = useCallback(async () => {
    const items = await paymentManagerPrimitive.getRemovable();
    setNames(items.map(i => i.name));
  }, []);

  return { names, refresh };
}

export function useExistingConnectorNames(managerName?: string) {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (!managerName) return;
    let cancelled = false;
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const project = await configIO.readProjectSpec();
        if (cancelled) return;
        const manager = (project.payments ?? []).find(p => p.name === managerName);
        setNames(manager ? manager.connectors.map(c => c.name) : []);
      } catch {
        if (!cancelled) setNames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [managerName]);

  const refresh = useCallback(
    async (mgr?: string) => {
      const target = mgr ?? managerName;
      if (!target) {
        setNames([]);
        return;
      }
      try {
        const configIO = new ConfigIO();
        const project = await configIO.readProjectSpec();
        const manager = (project.payments ?? []).find(p => p.name === target);
        setNames(manager ? manager.connectors.map(c => c.name) : []);
      } catch {
        setNames([]);
      }
    },
    [managerName]
  );

  return { names, refresh };
}
