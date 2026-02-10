import { APP_DIR, CONFIG_DIR, ConfigIO, findConfigRoot, setEnvVar, setSessionProjectRoot } from '../../../../lib';
import type { AgentCoreCliMcpDefs, AgentCoreMcpSpec, AgentCoreProjectSpec, DeployedState } from '../../../../schema';
import { getErrorMessage } from '../../../errors';
import { CreateLogger } from '../../../logging';
import { initGitRepo, setupPythonProject, writeEnvFile, writeGitignore } from '../../../operations';
import {
  mapGenerateConfigToRenderConfig,
  mapModelProviderToCredentials,
  mapModelProviderToIdentityProviders,
  writeAgentToProject,
} from '../../../operations/agent/generate';
import {
  computeDefaultCredentialEnvVarName,
  resolveCredentialStrategy,
} from '../../../operations/identity/create-identity';
import { CDKRenderer, createRenderer } from '../../../templates';
import { type Step, areStepsComplete, hasStepError } from '../../components';
import { withMinDuration } from '../../utils';
import { mapByoConfigToAgent } from '../agent';
import type { AddAgentConfig } from '../agent/types';
import type { GenerateConfig } from '../generate/types';
import { mkdir } from 'fs/promises';
import { basename, join } from 'path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type CreatePhase =
  | 'checking'
  | 'existing-project-error'
  | 'input'
  | 'create-prompt'
  | 'create-wizard'
  | 'running'
  | 'complete';

interface CreateFlowState {
  phase: CreatePhase;
  projectName: string;
  existingProjectPath?: string;
  steps: Step[];
  outputDir?: string;
  hasError: boolean;
  isComplete: boolean;
  logFilePath?: string;
  // Project name actions
  setProjectName: (name: string) => void;
  confirmProjectName: () => void;
  // Create prompt actions
  wantsCreate: boolean;
  setWantsCreate: (wants: boolean) => void;
  // Add agent config (set when AddAgentScreen completes)
  addAgentConfig: AddAgentConfig | null;
  handleAddAgentComplete: (config: AddAgentConfig) => void;
  goBackFromAddAgent: () => void;
}

function getCreateSteps(projectName: string, agentConfig: AddAgentConfig | null): Step[] {
  const steps: Step[] = [{ label: `Create ${projectName}/ project directory`, status: 'pending' }];

  if (agentConfig) {
    steps.push({ label: 'Add agent to project', status: 'pending' });
    if (agentConfig.language === 'Python' && agentConfig.agentType === 'create') {
      steps.push({ label: 'Set up Python environment', status: 'pending' });
    }
  }

  steps.push({ label: 'Prepare agentcore/ directory', status: 'pending' });
  steps.push({ label: 'Initialize git repository', status: 'pending' });

  return steps;
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

function createDefaultDeployedState(): DeployedState {
  return {
    targets: {},
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

/**
 * Convert directory name to valid project name.
 * Removes invalid characters and ensures it starts with a letter.
 */
function sanitizeProjectName(dirName: string): string {
  // Remove non-alphanumeric characters and capitalize words
  let name = dirName
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');

  // Ensure it starts with a letter
  if (!/^[a-zA-Z]/.test(name)) {
    name = 'Project' + name;
  }

  // Truncate to 36 chars
  return name.slice(0, 36) || 'Project';
}

export function useCreateFlow(cwd: string): CreateFlowState {
  const [phase, setPhase] = useState<CreatePhase>('checking');
  const defaultProjectName = useMemo(() => sanitizeProjectName(basename(cwd)), [cwd]);
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [existingProjectPath, setExistingProjectPath] = useState<string | undefined>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [outputDir, setOutputDir] = useState<string>();
  const [logFilePath, setLogFilePath] = useState<string | undefined>();

  // Create prompt state
  const [wantsCreate, setWantsCreate] = useState(false);

  // Add agent config (from AddAgentScreen)
  const [addAgentConfig, setAddAgentConfig] = useState<AddAgentConfig | null>(null);

  // Logger ref for the create operation
  const loggerRef = useRef<CreateLogger | null>(null);

  // Check for existing project on mount (walk up directory tree)
  useEffect(() => {
    if (phase !== 'checking') return;

    const checkExisting = () => {
      // Use findConfigRoot to walk up the directory tree looking for agentcore/
      const existingConfig = findConfigRoot(cwd);
      if (existingConfig) {
        // Found an existing project - error out
        setExistingProjectPath(existingConfig);
        setPhase('existing-project-error');
      } else {
        // No existing project found - proceed to input
        setPhase('input');
      }
    };

    void checkExisting();
  }, [cwd, phase]);

  const confirmProjectName = useCallback(() => {
    setPhase('create-prompt');
  }, []);

  const updateStep = (index: number, update: Partial<Step>) => {
    setSteps(prev => prev.map((s, i) => (i === index ? { ...s, ...update } : s)));
  };

  // Create prompt handlers
  const handleSetWantsCreate = useCallback(
    (wants: boolean) => {
      setWantsCreate(wants);
      if (wants) {
        setAddAgentConfig(null); // Reset any previous config
        setPhase('create-wizard');
      } else {
        // Skip add agent, go straight to running
        setAddAgentConfig(null);
        setSteps(getCreateSteps(projectName, null));
        setPhase('running');
      }
    },
    [projectName]
  );

  // Handle completion from AddAgentScreen
  const handleAddAgentComplete = useCallback(
    (config: AddAgentConfig) => {
      setAddAgentConfig(config);
      setSteps(getCreateSteps(projectName, config));
      setPhase('running');
    },
    [projectName]
  );

  // Go back from add agent wizard to create prompt
  const goBackFromAddAgent = useCallback(() => {
    setPhase('create-prompt');
  }, []);

  // Main running effect
  useEffect(() => {
    if (phase !== 'running') return;

    const run = async () => {
      // Project root is now cwd/projectName (creating a new directory)
      const projectRoot = join(cwd, projectName);
      const configBaseDir = join(projectRoot, CONFIG_DIR);
      let stepIndex = 0;

      // Create the logger (will initialize after config dir is created)
      const logger = new CreateLogger({ projectRoot });
      loggerRef.current = logger;
      setLogFilePath(logger.logFilePath);
      logger.log(`Starting project creation: ${projectName}`);
      logger.log(`Project root: ${projectRoot}`);

      try {
        // Step: Create project directory and config files
        logger.startStep('Create project directory and config files');
        updateStep(stepIndex, { status: 'running' });
        try {
          await withMinDuration(async () => {
            // Create the top-level project directory
            logger.logSubStep('Creating project directory...');
            await mkdir(projectRoot, { recursive: true });

            logger.logSubStep('Initializing config directory...');
            const configIO = new ConfigIO({ baseDir: configBaseDir });
            await configIO.initializeBaseDir();

            // Initialize logger now that the directory exists
            logger.initialize();

            // Set session project so subsequent operations find this project
            setSessionProjectRoot(projectRoot);

            // Create .gitignore inside agentcore/
            logger.logSubStep('Creating .gitignore...');
            await writeGitignore(configBaseDir);

            // Create empty .env file for secrets
            logger.logSubStep('Creating .env file...');
            await writeEnvFile(configBaseDir);

            // Create agentcore.json
            logger.logSubStep('Creating agentcore.json...');
            const projectSpec = createDefaultProjectSpec(projectName);
            await configIO.writeProjectSpec(projectSpec);

            // Create empty aws-targets.json (will be populated by deploy/plan)
            logger.logSubStep('Creating aws-targets.json...');
            await configIO.writeAWSDeploymentTargets([]);

            // Create deployed-state.json
            logger.logSubStep('Creating deployed-state.json...');
            const deployedState = createDefaultDeployedState();
            await configIO.writeDeployedState(deployedState);

            // Create mcp.json
            logger.logSubStep('Creating mcp.json...');
            const mcpSpec = createDefaultMcpSpec();
            await configIO.writeMcpSpec(mcpSpec);

            // Create mcp-defs.json
            logger.logSubStep('Creating mcp-defs.json...');
            const mcpDefs = createDefaultMcpDefs();
            await configIO.writeMcpDefs(mcpDefs);
          });
          logger.endStep('success');
          updateStep(stepIndex, { status: 'success' });
          stepIndex++;
        } catch (err) {
          const errMsg = getErrorMessage(err);
          logger.endStep('error', errMsg);
          updateStep(stepIndex, { status: 'error', error: errMsg });
          logger.finalize(false);
          return;
        }

        // Step: Add agent to project (if addAgentConfig is set)
        if (addAgentConfig) {
          logger.startStep('Add agent to project');
          updateStep(stepIndex, { status: 'running' });
          try {
            await withMinDuration(async () => {
              logger.logSubStep(`Adding agent: ${addAgentConfig.name}`);
              logger.logSubStep(`Type: ${addAgentConfig.agentType}, Language: ${addAgentConfig.language}`);

              if (addAgentConfig.agentType === 'create') {
                // Create path: generate agent from template
                const generateConfig: GenerateConfig = {
                  projectName: addAgentConfig.name,
                  sdk: addAgentConfig.framework,
                  modelProvider: addAgentConfig.modelProvider,
                  memory: addAgentConfig.memory,
                  language: addAgentConfig.language,
                  apiKey: addAgentConfig.apiKey,
                };

                logger.logSubStep(`Framework: ${generateConfig.sdk}`);

                // Resolve credential strategy FIRST (new project has no existing credentials)
                let identityProviders: ReturnType<typeof mapModelProviderToIdentityProviders> = [];
                let strategy: Awaited<ReturnType<typeof resolveCredentialStrategy>> | undefined;

                if (addAgentConfig.modelProvider !== 'Bedrock') {
                  strategy = await resolveCredentialStrategy(
                    projectName,
                    addAgentConfig.name,
                    addAgentConfig.modelProvider,
                    addAgentConfig.apiKey,
                    configBaseDir,
                    [] // New project has no existing credentials
                  );

                  identityProviders = [
                    {
                      name: strategy.credentialName,
                      envVarName: strategy.envVarName,
                    },
                  ];
                }

                // Render with correct identity provider
                const renderConfig = mapGenerateConfigToRenderConfig(generateConfig, identityProviders);
                const renderer = createRenderer(renderConfig);
                logger.logSubStep('Rendering agent template...');
                await renderer.render({ outputDir: projectRoot });
                logger.logSubStep('Writing agent to project...');

                if (strategy) {
                  await writeAgentToProject(generateConfig, { configBaseDir, credentialStrategy: strategy });

                  // Always write env var (empty if skipped) so users can easily find and fill it in
                  // Use project-scoped name if strategy returned empty (no API key case)
                  const envVarName =
                    strategy.envVarName ||
                    computeDefaultCredentialEnvVarName(`${projectName}${addAgentConfig.modelProvider}`);
                  logger.logSubStep('Writing API key env var to .env.local...');
                  await setEnvVar(envVarName, addAgentConfig.apiKey ?? '', configBaseDir);
                } else {
                  await writeAgentToProject(generateConfig, { configBaseDir });
                }
              } else {
                // BYO path: just write config to project (no file generation)
                logger.logSubStep('Writing BYO agent config to project...');

                // Create the agent code directory so users know where to put their code
                const codeDir = join(projectRoot, addAgentConfig.codeLocation.replace(/\/$/, ''));
                await mkdir(codeDir, { recursive: true });

                const configIO = new ConfigIO({ baseDir: configBaseDir });
                const project = await configIO.readProjectSpec();
                const agent = mapByoConfigToAgent(addAgentConfig);
                project.agents.push(agent);

                // Handle credentials for BYO (new project, so always project-scoped)
                if (addAgentConfig.modelProvider !== 'Bedrock') {
                  const strategy = await resolveCredentialStrategy(
                    projectName,
                    addAgentConfig.name,
                    addAgentConfig.modelProvider,
                    addAgentConfig.apiKey,
                    configBaseDir,
                    [] // New project has no existing credentials
                  );

                  if (!strategy.reuse) {
                    const credentials = mapModelProviderToCredentials(addAgentConfig.modelProvider, project.name);
                    if (credentials.length > 0) {
                      credentials[0]!.name = strategy.credentialName;
                      project.credentials.push(...credentials);
                    }
                  }

                  // Always write env var (empty if skipped) so users can easily find and fill it in
                  // Use project-scoped name if strategy returned empty (no API key case)
                  const envVarName =
                    strategy.envVarName ||
                    computeDefaultCredentialEnvVarName(`${projectName}${addAgentConfig.modelProvider}`);
                  logger.logSubStep('Writing API key env var to .env.local...');
                  await setEnvVar(envVarName, addAgentConfig.apiKey ?? '', configBaseDir);
                }

                await configIO.writeProjectSpec(project);
              }
            });
            logger.endStep('success');
            updateStep(stepIndex, { status: 'success' });
            stepIndex++;
          } catch (err) {
            const errMsg = getErrorMessage(err);
            logger.endStep('error', errMsg);
            updateStep(stepIndex, { status: 'error', error: errMsg });
            logger.finalize(false);
            return;
          }

          // Step: Set up Python environment (if Python and create path)
          if (addAgentConfig.language === 'Python' && addAgentConfig.agentType === 'create') {
            logger.startStep('Set up Python environment');
            updateStep(stepIndex, { status: 'running' });
            // Agent is in app/<agentName>/ directory
            const agentDir = join(projectRoot, APP_DIR, addAgentConfig.name);
            logger.logSubStep(`Agent directory: ${agentDir}`);
            logger.logSubStep('Running uv sync...');
            const result = await setupPythonProject({ projectDir: agentDir });

            if (result.status === 'success') {
              logger.endStep('success');
              updateStep(stepIndex, { status: 'success' });
            } else {
              logger.endStep('warn', 'Failed to set up Python environment');
              updateStep(stepIndex, {
                status: 'warn',
                warn: 'Failed to set up Python environment. Run "uv sync" manually to see the error.',
              });
            }
            stepIndex++;
          }
        }

        // Step: Create CDK project
        logger.startStep('Prepare agentcore/ directory (CDK project)');
        updateStep(stepIndex, { status: 'running' });
        try {
          const renderer = new CDKRenderer();
          const cdkDir = await withMinDuration(() => renderer.render({ projectRoot, logger }));
          setOutputDir(cdkDir);
          logger.endStep('success');
          updateStep(stepIndex, { status: 'success' });
          stepIndex++;
        } catch (err) {
          const errMsg = getErrorMessage(err);
          logger.endStep('error', errMsg);
          updateStep(stepIndex, { status: 'error', error: errMsg });
          logger.finalize(false);
          return;
        }

        // Step: Initialize git repository
        logger.startStep('Initialize git repository');
        updateStep(stepIndex, { status: 'running' });
        logger.logSubStep('Running git init...');
        const gitResult = await initGitRepo(projectRoot);
        if (gitResult.status === 'error') {
          logger.endStep('error', gitResult.message);
          updateStep(stepIndex, { status: 'error', error: gitResult.message });
          logger.finalize(false);
          return;
        } else if (gitResult.status === 'skipped') {
          logger.endStep('warn', gitResult.message);
          updateStep(stepIndex, { status: 'success', warn: gitResult.message });
        } else {
          logger.endStep('success');
          updateStep(stepIndex, { status: 'success' });
        }

        logger.finalize(true);
        setPhase('complete');
      } catch (err) {
        // Top-level catch - find current running step and mark as error
        const errMsg = getErrorMessage(err);
        logger.log(`Unexpected error: ${errMsg}`, 'error');
        logger.finalize(false);
        setSteps(prev => {
          const runningIndex = prev.findIndex(s => s.status === 'running');
          if (runningIndex >= 0) {
            return prev.map((s, i) => (i === runningIndex ? { ...s, status: 'error' as const, error: errMsg } : s));
          }
          return prev;
        });
      }
    };

    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const hasError = hasStepError(steps);
  const isComplete = areStepsComplete(steps);

  return {
    phase,
    projectName,
    existingProjectPath,
    steps,
    outputDir,
    hasError,
    isComplete,
    logFilePath,
    setProjectName,
    confirmProjectName,
    // Create prompt
    wantsCreate,
    setWantsCreate: handleSetWantsCreate,
    // Add agent
    addAgentConfig,
    handleAddAgentComplete,
    goBackFromAddAgent,
  };
}
