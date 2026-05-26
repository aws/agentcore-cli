import type { ImportResourceResult, ImportResult } from '../../../commands/import/types';
import { IMPORTABLE_RESOURCES } from '../../../commands/import/types';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { Panel } from '../../components/Panel';
import { Screen } from '../../components/Screen';
import { type Step, StepProgress } from '../../components/StepProgress';
import { HELP_TEXT } from '../../constants';
import type { ImportType } from './types.js';
import { toTelemetryCommand } from './utils.js';
import { useCallback, useEffect, useRef, useState } from 'react';

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
      const telemetryResult = await withCommandRunTelemetry(
        toTelemetryCommand(importType),
        {},
        async (): Promise<ImportResourceResult | ImportResult> => {
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

            return handler({ arn, code, onProgress });
          } else {
            const { handleImport } = await import('../../../commands/import/actions');
            return handleImport({ source: yamlPath!, onProgress });
          }
        }
      );

      if (telemetryResult.success) {
        setSteps(prev => prev.map(s => (s.status === 'running' ? { ...s, status: 'success' } : s)));
        onSuccess(telemetryResult);
      } else {
        setSteps(prev =>
          prev.map(s => (s.status === 'running' ? { ...s, status: 'error', error: telemetryResult.error.message } : s))
        );
        onError(telemetryResult.error.message ?? 'Import failed');
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
