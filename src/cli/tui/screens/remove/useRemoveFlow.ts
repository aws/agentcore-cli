import { CONFIG_DIR, ConfigIO, getWorkingDirectory } from '../../../../lib';
import type { AgentCoreCliMcpDefs, AgentCoreMcpSpec, AgentCoreProjectSpec } from '../../../../schema';
import { findStack } from '../../../cloudformation/stack-discovery';
import { getErrorMessage } from '../../../errors';
import { type Step, areStepsComplete, hasStepError } from '../../components';
import { withMinDuration } from '../../utils';
import { existsSync } from 'fs';
import { join } from 'path';
import { useCallback, useEffect, useMemo, useState } from 'react';

type RemovePhase = 'checking' | 'not-found' | 'confirm' | 'dry-run' | 'removing' | 'complete';

interface RemoveFlowOptions {
  force: boolean;
  dryRun: boolean;
}

interface RemoveFlowState {
  phase: RemovePhase;
  steps: Step[];
  itemsToRemove: string[];
  hasError: boolean;
  isComplete: boolean;
  hasDeployedResources: boolean;
  confirmRemoval: () => void;
}

function getRemoveSteps(): Step[] {
  return [{ label: 'Reset project schemas', status: 'pending' }];
}

function createDefaultProjectSpec(projectName: string): AgentCoreProjectSpec {
  return {
    name: projectName,
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
  };
}

function createDefaultMcpSpec(): AgentCoreMcpSpec {
  return {
    agentCoreGateways: [],
    mcpRuntimeTools: [],
  };
}

function createDefaultMcpDefs(): AgentCoreCliMcpDefs {
  return {
    tools: {},
  };
}

export function useRemoveFlow({ force, dryRun }: RemoveFlowOptions): RemoveFlowState {
  const [phase, setPhase] = useState<RemovePhase>('checking');
  const [steps, setSteps] = useState<Step[]>([]);
  const [itemsToRemove, setItemsToRemove] = useState<string[]>([]);
  const [hasDeployedResources, setHasDeployedResources] = useState(false);
  const [projectName, setProjectName] = useState<string>('');

  const cwd = useMemo(() => getWorkingDirectory(), []);
  const configDir = useMemo(() => join(cwd, CONFIG_DIR), [cwd]);

  // Check for existing project on mount
  useEffect(() => {
    if (phase !== 'checking') return;

    const checkProject = async () => {
      if (!existsSync(configDir)) {
        setPhase('not-found');
        return;
      }

      // Identify what will be reset
      const items: string[] = [];

      try {
        const configIO = new ConfigIO();
        const projectSpec = await configIO.readProjectSpec();
        setProjectName(projectSpec.name);
        items.push(`AgentCore project: ${projectSpec.name}`);

        // Check for deployed stacks per target
        try {
          const targets = await configIO.readAWSDeploymentTargets();
          for (const target of targets) {
            const stack = await findStack(target.region, projectSpec.name, target.name);
            if (stack) {
              setHasDeployedResources(true);
              break;
            }
          }
        } catch {
          // No targets or error checking stacks
        }

        if (projectSpec.agents && projectSpec.agents.length > 0) {
          items.push(`${projectSpec.agents.length} agent definition${projectSpec.agents.length > 1 ? 's' : ''}`);
        }
      } catch {
        // Project exists but has issues - still allow reset
        items.push('AgentCore project (corrupted or incomplete)');
      }

      items.push('All schemas will be reset to empty state');
      setItemsToRemove(items);

      if (dryRun) {
        setPhase('dry-run');
      } else if (force) {
        setSteps(getRemoveSteps());
        setPhase('removing');
      } else {
        setPhase('confirm');
      }
    };

    void checkProject();
  }, [cwd, configDir, phase, dryRun, force]);

  const confirmRemoval = useCallback(() => {
    setSteps(getRemoveSteps());
    setPhase('removing');
  }, []);

  const updateStep = (index: number, update: Partial<Step>) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...update } : s)));
  };

  // Main removal effect - resets all schemas to empty state
  useEffect(() => {
    if (phase !== 'removing') return;

    let isRunning = false;
    const runRemoval = async () => {
      if (isRunning) return;
      isRunning = true;

      try {
        // Reset all schemas to default empty state
        updateStep(0, { status: 'running' });
        try {
          await withMinDuration(async () => {
            const configIO = new ConfigIO();

            // Reset agentcore.json (keep project name)
            const defaultProjectSpec = createDefaultProjectSpec(projectName || 'Project');
            await configIO.writeProjectSpec(defaultProjectSpec);

            // Preserve aws-targets.json and deployed-state.json so that
            // a subsequent `agentcore deploy` can tear down existing stacks.

            // Reset mcp.json
            const defaultMcpSpec = createDefaultMcpSpec();
            await configIO.writeMcpSpec(defaultMcpSpec);

            // Reset mcp-defs.json
            const defaultMcpDefs = createDefaultMcpDefs();
            await configIO.writeMcpDefs(defaultMcpDefs);
          });
          updateStep(0, { status: 'success' });
        } catch (err) {
          updateStep(0, { status: 'error', error: getErrorMessage(err) });
          setPhase('complete');
          return;
        }

        setPhase('complete');
      } catch (err) {
        setSteps(prev => {
          const runningIndex = prev.findIndex(s => s.status === 'running');
          if (runningIndex >= 0) {
            return prev.map((s, i) =>
              i === runningIndex ? { ...s, status: 'error' as const, error: getErrorMessage(err) } : s
            );
          }
          return prev;
        });
        setPhase('complete');
      }
    };

    void runRemoval();
  }, [phase, projectName]);

  const hasError = hasStepError(steps);
  const isComplete = areStepsComplete(steps);

  return {
    phase,
    steps,
    itemsToRemove,
    hasError,
    isComplete,
    hasDeployedResources,
    confirmRemoval,
  };
}
