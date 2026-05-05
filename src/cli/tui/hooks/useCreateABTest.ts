import type { AddTargetBasedABTestOptions } from '../../primitives/ABTestPrimitive';
import { abTestPrimitive } from '../../primitives/registry';
import type { GatewayChoice } from '../screens/ab-test/types';
import { useCallback, useEffect, useState } from 'react';

interface CreateABTestConfig {
  name: string;
  description?: string;
  agent: string;
  gatewayChoice?: GatewayChoice;
  controlBundle: string;
  controlVersion: string;
  treatmentBundle: string;
  treatmentVersion: string;
  controlWeight: number;
  treatmentWeight: number;
  onlineEval: string;
  maxDuration?: number;
  enableOnCreate?: boolean;
}

export function useCreateABTest() {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'success' | 'error'; error?: string }>({
    state: 'idle',
  });

  const create = useCallback(async (config: CreateABTestConfig) => {
    setStatus({ state: 'loading' });
    try {
      const addResult = await abTestPrimitive.add({
        name: config.name,
        description: config.description,
        agent: config.agent,
        gatewayChoice: config.gatewayChoice,
        controlBundle: config.controlBundle,
        controlVersion: config.controlVersion,
        treatmentBundle: config.treatmentBundle,
        treatmentVersion: config.treatmentVersion,
        controlWeight: config.controlWeight,
        treatmentWeight: config.treatmentWeight,
        onlineEval: config.onlineEval,
        maxDurationDays: config.maxDuration,
        enableOnCreate: config.enableOnCreate,
      });
      if (!addResult.success) {
        throw new Error(addResult.error?.message ?? 'Failed to create AB test');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, testName: config.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create AB test.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const createTargetBased = useCallback(async (config: Omit<AddTargetBasedABTestOptions, 'roleArn'>) => {
    setStatus({ state: 'loading' });
    try {
      const addResult = await abTestPrimitive.addTargetBased(config);
      if (!addResult.success) {
        throw new Error(addResult.error?.message ?? 'Failed to create target-based AB test');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, testName: config.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create target-based AB test.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createABTest: create, createTargetBasedABTest: createTargetBased, reset };
}

export function useExistingABTestNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void abTestPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await abTestPrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}
