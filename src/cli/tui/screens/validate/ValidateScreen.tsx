import { ConfigIO, findConfigRoot } from '../../../../lib';
import { NextSteps, Screen, StepProgress } from '../../components';
import type { Step } from '../../components';
import { STATUS_COLORS } from '../../theme';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

interface ValidateScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'validating' | 'success' | 'error';

interface ValidationState {
  phase: Phase;
  steps: Step[];
  projectName: string | null;
  error: string | null;
}

const SCHEMA_FILES = [
  { key: 'project', label: 'agentcore.json', required: true },
  { key: 'targets', label: 'aws-targets.json', required: true },
  { key: 'mcp', label: 'mcp.json', required: false },
  { key: 'mcpDefs', label: 'mcp-defs.json', required: false },
  { key: 'state', label: '.cli/state.json', required: false },
] as const;

export function ValidateScreen({ isInteractive, onExit }: ValidateScreenProps) {
  const [state, setState] = useState<ValidationState>({
    phase: 'validating',
    steps: SCHEMA_FILES.map(f => ({ label: f.label, status: 'pending' })),
    projectName: null,
    error: null,
  });

  useEffect(() => {
    const runValidation = async () => {
      const configRoot = findConfigRoot(process.cwd());
      if (!configRoot) {
        setState(prev => ({
          ...prev,
          phase: 'error',
          error: 'No AgentCore project found in current directory',
          steps: prev.steps.map((s, i) =>
            i === 0 ? { label: s.label, status: 'error', error: 'Project not found' } : s
          ),
        }));
        return;
      }

      const configIO = new ConfigIO({ baseDir: configRoot });
      let projectName: string | null = null;

      // Validate each file step by step
      const newSteps: Step[] = SCHEMA_FILES.map(f => ({ label: f.label, status: 'pending' as const }));

      for (let i = 0; i < SCHEMA_FILES.length; i++) {
        const file = SCHEMA_FILES[i];
        if (!file) continue;

        const currentStep = newSteps[i];
        if (!currentStep) continue;

        newSteps[i] = { label: currentStep.label, status: 'running' };
        setState(prev => ({ ...prev, steps: [...newSteps] }));

        // Small delay to show progress
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
          if (file.key === 'project') {
            const spec = await configIO.readProjectSpec();
            projectName = spec.name;
            newSteps[i] = { label: file.label, status: 'success' };
          } else if (file.key === 'targets') {
            await configIO.readAWSDeploymentTargets();
            newSteps[i] = { label: file.label, status: 'success' };
          } else if (file.key === 'mcp') {
            if (configIO.configExists('mcp')) {
              await configIO.readMcpSpec();
              newSteps[i] = { label: file.label, status: 'success' };
            } else {
              newSteps[i] = { label: file.label, status: 'info', info: 'Not present (optional)' };
            }
          } else if (file.key === 'mcpDefs') {
            if (configIO.configExists('mcpDefs')) {
              await configIO.readMcpDefs();
              newSteps[i] = { label: file.label, status: 'success' };
            } else {
              newSteps[i] = { label: file.label, status: 'info', info: 'Not present (optional)' };
            }
          } else if (file.key === 'state') {
            if (configIO.configExists('state')) {
              await configIO.readDeployedState();
              newSteps[i] = { label: file.label, status: 'success' };
            } else {
              newSteps[i] = { label: file.label, status: 'info', info: 'Not present (optional)' };
            }
          }
          setState(prev => ({ ...prev, steps: [...newSteps], projectName }));
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          newSteps[i] = { label: file.label, status: 'error', error: errorMsg };
          setState({
            phase: 'error',
            steps: [...newSteps],
            projectName,
            error: errorMsg,
          });
          return;
        }
      }

      setState({
        phase: 'success',
        steps: newSteps,
        projectName,
        error: null,
      });
    };

    void runValidation();
  }, []);

  const headerContent = state.projectName ? (
    <Box>
      <Text>Project: </Text>
      <Text color={STATUS_COLORS.success}>{state.projectName}</Text>
    </Box>
  ) : undefined;

  return (
    <Screen title="AgentCore Validate" onExit={onExit} headerContent={headerContent}>
      <Box flexDirection="column" marginTop={1}>
        <StepProgress steps={state.steps} />

        {state.phase === 'success' && (
          <Box marginTop={1}>
            <Text color={STATUS_COLORS.success}>All schemas valid</Text>
          </Box>
        )}

        {state.phase === 'error' && (
          <Box marginTop={1}>
            <Text color={STATUS_COLORS.error}>Validation failed</Text>
          </Box>
        )}

        {(state.phase === 'success' || state.phase === 'error') && (
          <NextSteps steps={[]} isInteractive={isInteractive} onBack={onExit} isActive={true} />
        )}
      </Box>
    </Screen>
  );
}
