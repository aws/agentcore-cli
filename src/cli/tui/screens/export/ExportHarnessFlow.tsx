import { formatExportNotes } from '../../../commands/export/types';
import type { ExportNote } from '../../../commands/export/types';
import { ErrorPrompt, GradientText, NextSteps, Screen, StepProgress } from '../../components';
import type { NextStep, Step } from '../../components';
import { ExportHarnessScreen } from './ExportHarnessScreen';
import type { ExportHarnessConfig } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'wizard'; harnessNames: string[]; existingAgentNames: string[]; containerOnlyHarnesses: Set<string> }
  | { name: 'no-harnesses' }
  | { name: 'exporting'; steps: Step[] }
  | { name: 'success'; agentName: string; notesPath: string; notes: ExportNote[] }
  | { name: 'error'; message: string };

interface ExportHarnessFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDeploy?: () => void;
}

const EXPORT_SUCCESS_STEPS: NextStep[] = [{ command: 'deploy', label: 'Deploy to AWS' }];

export function ExportHarnessFlow({ isInteractive = true, onExit, onBack, onDeploy }: ExportHarnessFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  useEffect(() => {
    void (async () => {
      try {
        const { ConfigIO } = await import('../../../../lib');
        const configIO = new ConfigIO();
        if (!configIO.hasProject()) {
          setFlow({ name: 'no-harnesses' });
          return;
        }
        const project = await configIO.readProjectSpec();
        const harnessNames = (project.harnesses ?? []).map((h: { name: string }) => h.name);
        if (harnessNames.length === 0) {
          setFlow({ name: 'no-harnesses' });
          return;
        }
        const existingAgentNames = project.runtimes.map((r: { name: string }) => r.name);
        const containerOnlyHarnesses = new Set<string>();
        await Promise.all(
          harnessNames.map(async (name: string) => {
            try {
              const spec = await configIO.readHarnessSpec(name);
              if (spec.containerUri || spec.dockerfile) containerOnlyHarnesses.add(name);
            } catch {
              // unreadable spec — leave unrestricted, mapper will error on export
            }
          })
        );
        setFlow({ name: 'wizard', harnessNames, existingAgentNames, containerOnlyHarnesses });
      } catch (err) {
        const { getErrorMessage } = await import('../../../errors');
        setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();
  }, []);

  useEffect(() => {
    if (!isInteractive && flow.name === 'success') {
      onExit();
    }
  }, [isInteractive, flow, onExit]);

  const handleComplete = useCallback(async (config: ExportHarnessConfig) => {
    const progressSteps: Step[] = [
      { label: 'Reading harness configuration', status: 'running' },
      { label: 'Mapping to Strands template config', status: 'pending' },
      { label: 'Rendering agent code', status: 'pending' },
      ...(config.build === 'Container'
        ? [{ label: 'Generating uv.lock for container build', status: 'pending' as const }]
        : []),
      { label: 'Updating agentcore.json', status: 'pending' },
      { label: 'Writing EXPORT_NOTES.md', status: 'pending' },
    ];
    setFlow({ name: 'exporting', steps: progressSteps });

    let stepIdx = 0;
    const advanceStep = (_message: string) => {
      const currentStep = progressSteps[stepIdx];
      if (currentStep) {
        progressSteps[stepIdx] = { ...currentStep, status: 'success' };
      }
      stepIdx++;
      const nextStep = progressSteps[stepIdx];
      if (nextStep) {
        progressSteps[stepIdx] = { ...nextStep, status: 'running' };
      }
      setFlow({ name: 'exporting', steps: [...progressSteps] });
    };

    try {
      const { handleExportHarness } = await import('../../../commands/export/harness-action');
      const result = await handleExportHarness(
        { name: config.harness, targetAgentName: config.targetAgentName, build: config.build },
        { onProgress: advanceStep }
      );

      // Mark last running step as success
      const lastStep = progressSteps[stepIdx];
      if (lastStep) {
        progressSteps[stepIdx] = { ...lastStep, label: lastStep.label, status: 'success' };
        setFlow({ name: 'exporting', steps: [...progressSteps] });
      }

      if (!result.success) {
        setFlow({ name: 'error', message: result.error.message });
        return;
      }

      setFlow({ name: 'success', agentName: result.agentName, notesPath: result.notesPath, notes: result.notes });
    } catch (err) {
      const { getErrorMessage } = await import('../../../errors');
      setFlow({ name: 'error', message: getErrorMessage(err) });
    }
  }, []);

  if (flow.name === 'loading') {
    return (
      <Screen title="Export Harness to Python Strands Agent" onExit={onBack}>
        <GradientText text="Loading harnesses..." />
      </Screen>
    );
  }

  if (flow.name === 'no-harnesses') {
    return (
      <ErrorPrompt
        message="No harnesses found"
        detail="Add a harness first with `agentcore add harness` before exporting."
        onBack={onBack}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'wizard') {
    return (
      <ExportHarnessScreen
        harnessNames={flow.harnessNames}
        existingAgentNames={flow.existingAgentNames}
        containerOnlyHarnesses={flow.containerOnlyHarnesses}
        onComplete={config => void handleComplete(config)}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'exporting') {
    return (
      <Screen
        title="Export Harness to Python Strands Agent"
        onExit={() => {
          /* noop while exporting */
        }}
      >
        <StepProgress steps={flow.steps} />
      </Screen>
    );
  }

  if (flow.name === 'success') {
    const handleSelect = (step: NextStep) => {
      if (step.command === 'deploy') {
        onDeploy?.();
      } else {
        onExit();
      }
    };

    return (
      <Screen title="Export Harness to Python Strands Agent" onExit={onExit}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text color="green">✓ Exported harness → runtime agent {flow.agentName}</Text>
            <Text dimColor>Generated: app/{flow.agentName}/ · agentcore/agentcore.json updated</Text>
          </Box>

          {/* Surface manual follow-up notes inline so they aren't missed (also in EXPORT_NOTES.md).
              Shared formatter keeps the wording in sync with the CLI. */}
          <Box flexDirection="column">
            {formatExportNotes(flow.notes, flow.notesPath).map((line, i) => (
              <Text key={i} color={line.tone === 'warn' ? 'yellow' : undefined} dimColor={line.tone === 'dim'}>
                {line.text}
              </Text>
            ))}
          </Box>

          {isInteractive && (
            <NextSteps steps={EXPORT_SUCCESS_STEPS} isInteractive={true} onSelect={handleSelect} onBack={onExit} />
          )}
        </Box>
      </Screen>
    );
  }

  if (flow.name === 'error') {
    return <ErrorPrompt message="Export failed" detail={flow.message} onBack={onBack} onExit={onExit} />;
  }

  return null;
}
