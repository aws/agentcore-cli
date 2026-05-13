import type { EvaluatorConfig } from '../../../schema';
import { evaluatorPrimitive } from '../../primitives/registry';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { Level, standardize } from '../../telemetry/schemas/common-shapes.js';
import { useCallback, useEffect, useState } from 'react';

interface CreateEvaluatorConfig {
  name: string;
  level: string;
  config: EvaluatorConfig;
  kmsKeyArn?: string;
}

export function useCreateEvaluator() {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'success' | 'error'; error?: string }>({
    state: 'idle',
  });

  const create = useCallback(async (config: CreateEvaluatorConfig) => {
    setStatus({ state: 'loading' });
    try {
      const addResult = await withCommandRunTelemetry(
        'add.evaluator',
        {
          evaluator_type: config.config.codeBased ? 'code-based' : 'llm-as-a-judge',
          level: standardize(Level, config.level),
        },
        () =>
          evaluatorPrimitive.add({
            name: config.name,
            level: config.level as 'SESSION' | 'TRACE' | 'TOOL_CALL',
            config: config.config,
            kmsKeyArn: config.kmsKeyArn,
          })
      );
      if (!addResult.success) {
        throw new Error(addResult.error?.message ?? 'Failed to create evaluator');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, evaluatorName: config.name, codePath: addResult.codePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create evaluator.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createEvaluator: create, reset };
}

export function useExistingEvaluatorNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void evaluatorPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await evaluatorPrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}
