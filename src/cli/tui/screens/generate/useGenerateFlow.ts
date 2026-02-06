import { APP_DIR, ConfigIO } from '../../../../lib';
import { getErrorMessage } from '../../../errors';
import { type PythonSetupResult, setupPythonProject } from '../../../operations';
import { mapGenerateConfigToRenderConfig, writeAgentToProject } from '../../../operations/agent/generate';
import { createRenderer } from '../../../templates';
import type { Step } from '../../components';
import { useProject } from '../../hooks';
import type { GenerateConfig } from './types';
import { join } from 'path';
import { useCallback, useEffect, useState } from 'react';

export type GeneratePhase = 'wizard' | 'running' | 'complete';

interface GenerateFlowState {
  phase: GeneratePhase;
  steps: Step[];
  outputDir: string | null;
  pythonSetupResult: PythonSetupResult | null;
  startGenerate: (config: GenerateConfig) => void;
}

function getSteps(isPython: boolean): Step[] {
  const steps: Step[] = [{ label: 'Generate project files', status: 'pending' }];
  if (isPython) {
    steps.push({ label: 'Set up project python environment', status: 'pending' });
  }
  return steps;
}

export function useGenerateFlow(): GenerateFlowState {
  const { project, error: projectError } = useProject();
  const [phase, setPhase] = useState<GeneratePhase>('wizard');
  const [config, setConfig] = useState<GenerateConfig | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [pythonSetupResult, setPythonSetupResult] = useState<PythonSetupResult | null>(null);

  const updateStep = (index: number, update: Partial<Step>) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...update } : s)));
  };

  const startGenerate = useCallback((cfg: GenerateConfig) => {
    const isPython = cfg.language === 'Python';
    setConfig(cfg);
    setSteps(getSteps(isPython));
    setPhase('running');
  }, []);

  useEffect(() => {
    if (phase !== 'running' || !config) return;

    const run = async () => {
      const isPython = config.language === 'Python';

      // Check project availability (from useProject hook)
      if (!project) {
        updateStep(0, { status: 'error', error: projectError ?? 'No agentcore project found.' });
        setPhase('complete');
        return;
      }
      // Agent is in app/<agentName>/ directory
      const projectDir = join(project.projectRoot, APP_DIR, config.projectName);

      // Step 0: Generate project files and update project config
      updateStep(0, { status: 'running' });
      try {
        // Read project spec to get the actual project name for credential naming
        const configIO = new ConfigIO({ baseDir: project.configRoot });
        const projectSpec = await configIO.readProjectSpec();

        // Pass actual project name for credential naming in templates
        const renderConfig = mapGenerateConfigToRenderConfig(config, projectSpec.name);
        const renderer = createRenderer(renderConfig);
        await renderer.render({ outputDir: project.projectRoot });
        await writeAgentToProject(config);
        setOutputDir(projectDir);
        updateStep(0, { status: 'success' });
      } catch (err) {
        updateStep(0, { status: 'error', error: getErrorMessage(err) });
        setPhase('complete');
        return;
      }

      // Step 1: Python setup (if applicable)
      if (isPython) {
        updateStep(1, { status: 'running' });
        const result = await setupPythonProject({ projectDir });
        setPythonSetupResult(result);

        if (result.status === 'success') {
          updateStep(1, { status: 'success' });
        } else {
          updateStep(1, {
            status: 'warn',
            warn: 'Failed to set up Python environment. Run "uv sync" manually to see the error.',
          });
        }
      }

      setPhase('complete');
    };

    void run();
  }, [phase, config, project, projectError]);

  return {
    phase,
    steps,
    outputDir,
    pythonSetupResult,
    startGenerate,
  };
}
