import { ConfigIO, findConfigRoot } from '../../../../lib';
import { handlePackage, loadPackageConfig } from '../../../commands/package';
import type { PackageAgentResult } from '../../../commands/package';
import { Screen, StepProgress } from '../../components';
import type { Step } from '../../components';
import { STATUS_COLORS } from '../../theme';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

interface PackageScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'loading' | 'packaging' | 'success' | 'error';

interface PackageState {
  phase: Phase;
  projectName: string | null;
  steps: Step[];
  results: PackageAgentResult[];
  skipped: string[];
  error: string | null;
  totalSize: string | null;
}

export function PackageScreen({ isInteractive: _isInteractive, onExit }: PackageScreenProps) {
  const [state, setState] = useState<PackageState>({
    phase: 'loading',
    projectName: null,
    steps: [],
    results: [],
    skipped: [],
    error: null,
    totalSize: null,
  });

  useEffect(() => {
    const runPackaging = async () => {
      const configRoot = findConfigRoot(process.cwd());
      if (!configRoot) {
        setState(prev => ({
          ...prev,
          phase: 'error',
          error: 'No AgentCore project found in current directory',
        }));
        return;
      }

      try {
        // Load project config
        const configIO = new ConfigIO({ baseDir: configRoot });
        const projectSpec = await configIO.readProjectSpec();
        const agents = projectSpec.agents;

        if (agents.length === 0) {
          setState({
            phase: 'error',
            projectName: projectSpec.name,
            steps: [],
            results: [],
            skipped: [],
            error: 'No agents found in project',
            totalSize: null,
          });
          return;
        }

        // Initialize steps for all agents
        const initialSteps: Step[] = agents.map(a => ({
          label: a.name,
          status: 'pending',
        }));

        setState(prev => ({
          ...prev,
          phase: 'packaging',
          projectName: projectSpec.name,
          steps: initialSteps,
        }));

        // Load package context
        const context = await loadPackageConfig({});

        // Process each agent
        const results: PackageAgentResult[] = [];
        const skipped: string[] = [];
        const newSteps: Step[] = [...initialSteps];

        for (let i = 0; i < agents.length; i++) {
          const agent = agents[i];
          if (!agent) continue;

          const currentStep = newSteps[i];
          if (!currentStep) continue;

          newSteps[i] = { label: currentStep.label, status: 'running' };
          setState(prev => ({ ...prev, steps: [...newSteps] }));

          // Small delay to show progress
          await new Promise(resolve => setTimeout(resolve, 100));

          try {
            // Package this specific agent
            const singleAgentContext = { ...context, targetAgent: agent.name };
            const result = await handlePackage(singleAgentContext);

            if (result.skipped.length > 0) {
              skipped.push(...result.skipped);
              newSteps[i] = {
                label: agent.name,
                status: 'warn',
                warn: 'Skipped: no container runtime available',
              };
              setState(prev => ({ ...prev, steps: [...newSteps], skipped }));
            } else {
              const agentResult = result.results[0];
              if (agentResult) {
                results.push(agentResult);
                newSteps[i] = {
                  label: `${agent.name} → ${agentResult.artifactPath}`,
                  status: 'success',
                  info: `${agentResult.sizeMb} MB`,
                };
              }
              setState(prev => ({ ...prev, steps: [...newSteps], results }));
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            newSteps[i] = {
              label: agent.name,
              status: 'error',
              error: errorMsg,
            };
            setState({
              phase: 'error',
              projectName: projectSpec.name,
              steps: [...newSteps],
              results,
              skipped,
              error: errorMsg,
              totalSize: null,
            });
            return;
          }
        }

        // Calculate total size
        const totalMb = results.reduce((sum, r) => sum + parseFloat(r.sizeMb), 0).toFixed(2);

        setState({
          phase: 'success',
          projectName: projectSpec.name,
          steps: newSteps,
          results,
          skipped,
          error: null,
          totalSize: totalMb,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setState(prev => ({
          ...prev,
          phase: 'error',
          error: errorMsg,
        }));
      }
    };

    void runPackaging();
  }, []);

  const headerContent = state.projectName ? (
    <Box>
      <Text>Project: </Text>
      <Text color={STATUS_COLORS.success}>{state.projectName}</Text>
    </Box>
  ) : undefined;

  if (state.phase === 'loading') {
    return (
      <Screen title="AgentCore Package" onExit={onExit} headerContent={headerContent}>
        <Text dimColor>Loading project...</Text>
      </Screen>
    );
  }

  return (
    <Screen title="AgentCore Package" onExit={onExit} headerContent={headerContent}>
      <Box flexDirection="column" marginTop={1}>
        {state.steps.length > 0 && <StepProgress steps={state.steps} />}

        {state.phase === 'success' && state.results.length > 0 && (
          <Box marginTop={1}>
            <Text color={STATUS_COLORS.success}>
              Packaged {state.results.length} agent{state.results.length !== 1 ? 's' : ''} ({state.totalSize} MB total)
            </Text>
          </Box>
        )}

        {state.phase === 'success' && state.results.length === 0 && state.skipped.length > 0 && (
          <Box marginTop={1}>
            <Text color={STATUS_COLORS.warning}>No agents packaged (all skipped)</Text>
          </Box>
        )}

        {state.phase === 'error' && (
          <Box marginTop={1} flexDirection="column">
            <Text color={STATUS_COLORS.error}>Packaging failed</Text>
            {state.error && (
              <Text color={STATUS_COLORS.error} dimColor>
                {state.error}
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Screen>
  );
}
