import type { ImportResourceResult, ImportResult } from '../../../commands/import/types';
import { IMPORTABLE_RESOURCES } from '../../../commands/import/types';
import { Panel } from '../../components/Panel';
import { Screen } from '../../components/Screen';
import { type Step, StepProgress } from '../../components/StepProgress';
import { HELP_TEXT } from '../../constants';
import type { ImportType } from './ImportSelectScreen';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ImportProgressScreenProps {
  importType: ImportType;
  arn?: string;
  code?: string;
  yamlPath?: string;
  onSuccess: (result: ImportResourceResult | ImportResult) => void;
  onError: (message: string) => void;
  onExit: () => void;
}

export function ImportProgressScreen({
  importType,
  arn,
  code,
  yamlPath,
  onSuccess,
  onError,
  onExit,
}: ImportProgressScreenProps) {
  const [steps, setSteps] = useState<Step[]>([{ label: `Importing ${importType}...`, status: 'running' }]);
  const started = useRef(false);

  const onProgress = useCallback((message: string) => {
    setSteps(prev => {
      const updated = prev.map(s => (s.status === 'running' ? { ...s, status: 'success' as const } : s));
      return [...updated, { label: message, status: 'running' as const }];
    });
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      if ((IMPORTABLE_RESOURCES as readonly string[]).includes(importType)) {
        const handler =
          importType === 'runtime'
            ? (await import('../../../commands/import/import-runtime')).handleImportRuntime
            : importType === 'memory'
              ? (await import('../../../commands/import/import-memory')).handleImportMemory
              : importType === 'evaluator'
                ? (await import('../../../commands/import/import-evaluator')).handleImportEvaluator
                : importType === 'gateway'
                  ? (await import('../../../commands/import/import-gateway')).handleImportGateway
                  : (await import('../../../commands/import/import-online-eval')).handleImportOnlineEval;

        const result = await handler({ arn, code, onProgress });
        if (result.success) {
          setSteps(prev => prev.map(s => (s.status === 'running' ? { ...s, status: 'success' } : s)));
          onSuccess(result);
        } else {
          setSteps(prev =>
            prev.map(s => (s.status === 'running' ? { ...s, status: 'error', error: result.error } : s))
          );
          onError(result.error ?? 'Import failed');
        }
      } else {
        // Starter toolkit
        const { handleImport } = await import('../../../commands/import/actions');
        const result = await handleImport({
          source: yamlPath!,
          onProgress,
        });
        if (result.success) {
          setSteps(prev => prev.map(s => (s.status === 'running' ? { ...s, status: 'success' } : s)));
          onSuccess(result);
        } else {
          setSteps(prev =>
            prev.map(s => (s.status === 'running' ? { ...s, status: 'error', error: result.error } : s))
          );
          onError(result.error ?? 'Import failed');
        }
      }
    };

    void run();
  }, [importType, arn, code, yamlPath, onProgress, onSuccess, onError]);

  const isRunning = steps.some(s => s.status === 'running');

  return (
    <Screen
      title="Importing..."
      onExit={onExit}
      exitEnabled={!isRunning}
      helpText={isRunning ? 'Import in progress...' : HELP_TEXT.BACK}
    >
      <Panel>
        <StepProgress steps={steps} />
      </Panel>
    </Screen>
  );
}
