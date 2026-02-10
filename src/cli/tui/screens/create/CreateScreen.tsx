import { ProjectNameSchema } from '../../../../schema';
import { computeDefaultCredentialEnvVarName } from '../../../operations/identity/create-identity';
import {
  LogLink,
  type NextStep,
  NextSteps,
  Screen,
  SelectList,
  type Step,
  StepProgress,
  TextInput,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { setExitMessage } from '../../exit-message';
import { useListNavigation } from '../../hooks';
import { STATUS_COLORS } from '../../theme';
import { AddAgentScreen } from '../agent/AddAgentScreen';
import type { AddAgentConfig } from '../agent/types';
import { FRAMEWORK_OPTIONS } from '../agent/types';
import { useCreateFlow } from './useCreateFlow';
import { Box, Text, useApp } from 'ink';
import { join } from 'path';
import { useCallback, useEffect } from 'react';

/** Build a text representation of the completion screen for terminal output */
function buildExitMessage(projectName: string, steps: Step[], agentConfig: AddAgentConfig | null): string {
  const lines: string[] = [];

  // Title
  lines.push('\x1b[1mAgentCore Create\x1b[0m');
  lines.push('');

  // Project name
  lines.push(`Project: \x1b[32m${projectName}\x1b[0m`);
  lines.push('');

  // Steps
  for (const step of steps) {
    const statusLabel = step.status === 'success' ? '\x1b[32m[done]\x1b[0m' : `[${step.status}]`;
    lines.push(`${statusLabel}  ${step.label}`);
  }
  lines.push('');

  // Created summary
  lines.push('\x1b[2mCreated:\x1b[0m');
  lines.push(`  ${projectName}/`);
  if (agentConfig?.agentType === 'create') {
    const frameworkOption = FRAMEWORK_OPTIONS.find(o => o.id === agentConfig.framework);
    const frameworkLabel = frameworkOption?.title ?? agentConfig.framework;
    const agentPath = `app/${agentConfig.name}/`;
    const agentcorePath = 'agentcore/';
    const maxPathLen = Math.max(agentPath.length, agentcorePath.length);
    lines.push(`    ${agentPath.padEnd(maxPathLen)}  \x1b[2m${agentConfig.language} agent (${frameworkLabel})\x1b[0m`);
    lines.push(`    ${agentcorePath.padEnd(maxPathLen)}  \x1b[2mConfig and CDK project\x1b[0m`);
  } else if (agentConfig?.agentType === 'byo') {
    const agentPath = agentConfig.codeLocation;
    const agentcorePath = 'agentcore/';
    const maxPathLen = Math.max(agentPath.length, agentcorePath.length);
    lines.push(`    ${agentPath.padEnd(maxPathLen)}  \x1b[2mAgent code location (empty)\x1b[0m`);
    lines.push(`    ${agentcorePath.padEnd(maxPathLen)}  \x1b[2mConfig and CDK project\x1b[0m`);
  } else {
    lines.push(`    agentcore/  \x1b[2mConfig and CDK project\x1b[0m`);
  }
  lines.push('');

  // API key reminder if skipped
  if (agentConfig && agentConfig.modelProvider !== 'Bedrock' && !agentConfig.apiKey) {
    const credentialName = `${projectName}${agentConfig.modelProvider}`;
    const envVarName = computeDefaultCredentialEnvVarName(credentialName);
    lines.push('\x1b[33mNote:\x1b[0m API key not configured.');
    lines.push(`Fill in \x1b[36m${envVarName}\x1b[0m in agentcore/.env.local before running.`);
    lines.push('');
  }

  // BYO code location reminder
  if (agentConfig?.agentType === 'byo') {
    lines.push(`\x1b[33mCopy your agent code to \x1b[36m${agentConfig.codeLocation}\x1b[33m before deploying.\x1b[0m`);
    lines.push(`\x1b[2mEnsure \x1b[36m${agentConfig.entrypoint}\x1b[2m is the entrypoint file in that folder.\x1b[0m`);
    lines.push('');
  }

  // Success message
  lines.push('\x1b[32mProject created successfully!\x1b[0m');
  lines.push('');

  // Instructions
  lines.push('To continue, navigate to your new project:');
  lines.push('');
  lines.push(`  cd ${projectName}`);
  lines.push('  agentcore');
  lines.push('');

  return lines.join('\n');
}

type NextCommand = 'dev' | 'deploy' | 'add';

interface NavigateParams {
  command: NextCommand;
  workingDir: string;
}

interface CreateScreenProps {
  cwd: string;
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  onNavigate?: (params: NavigateParams) => void;
}

/** Next steps shown after successful project creation */
function getCreateNextSteps(hasAgent: boolean): NextStep[] {
  if (hasAgent) {
    return [
      { command: 'dev', label: 'Run agent locally' },
      { command: 'deploy', label: 'Deploy to AWS' },
    ];
  }
  return [{ command: 'add', label: 'Add an agent' }];
}

const CREATE_PROMPT_ITEMS = [
  { id: 'yes', title: 'Yes, add an agent' },
  { id: 'no', title: "No, I'll do it later" },
];

/** Tree-style display of created project structure */
function CreatedSummary({ projectName, agentConfig }: { projectName: string; agentConfig: AddAgentConfig | null }) {
  const getFrameworkLabel = (framework: string) => {
    const option = FRAMEWORK_OPTIONS.find(o => o.id === framework);
    return option?.title ?? framework;
  };

  const isCreate = agentConfig?.agentType === 'create';
  const isByo = agentConfig?.agentType === 'byo';
  const agentPath = isCreate ? `app/${agentConfig.name}/` : isByo ? agentConfig.codeLocation : null;
  const agentcorePath = 'agentcore/';
  const maxPathLen = agentPath ? Math.max(agentPath.length, agentcorePath.length) : agentcorePath.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Created:</Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text>{projectName}/</Text>
        {isCreate && agentPath && (
          <Box marginLeft={2}>
            <Text>
              {agentPath.padEnd(maxPathLen)}
              <Text dimColor>
                {'  '}
                {agentConfig.language} agent ({getFrameworkLabel(agentConfig.framework)})
              </Text>
            </Text>
          </Box>
        )}
        {isByo && agentPath && (
          <Box marginLeft={2}>
            <Text>
              {agentPath.padEnd(maxPathLen)}
              <Text dimColor>{'  '}Agent code location</Text>
            </Text>
          </Box>
        )}
        <Box marginLeft={2}>
          <Text>
            {agentcorePath.padEnd(maxPathLen)}
            <Text dimColor>{'  '}Config and CDK project</Text>
          </Text>
        </Box>
      </Box>
      {isByo && agentConfig && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            Copy your agent code to <Text color="cyan">{agentConfig.codeLocation}</Text> before deploying.
          </Text>
          <Text dimColor>
            Ensure <Text color="cyan">{agentConfig.entrypoint}</Text> is the entrypoint file in that folder.
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function CreateScreen({ cwd, isInteractive, onExit, onNavigate }: CreateScreenProps) {
  const { exit } = useApp();
  const flow = useCreateFlow(cwd);
  // Project root is cwd/projectName (new project directory)
  const projectRoot = join(cwd, flow.projectName);

  // Completion state for next steps
  const allSuccess = !flow.hasError && flow.isComplete;

  // Handle exit - if successful, exit app completely and print completion screen
  const handleExit = useCallback(() => {
    if (allSuccess && isInteractive) {
      // Set message to be printed after TUI exits (full completion screen)
      setExitMessage(buildExitMessage(flow.projectName, flow.steps, flow.addAgentConfig));
      exit();
    } else {
      onExit();
    }
  }, [allSuccess, isInteractive, flow.projectName, flow.steps, flow.addAgentConfig, exit, onExit]);

  // Auto-exit when project creation completes successfully
  useEffect(() => {
    if (allSuccess && isInteractive) {
      handleExit();
    }
  }, [allSuccess, isInteractive, handleExit]);

  // Create prompt navigation
  const { selectedIndex: createPromptIndex } = useListNavigation({
    items: CREATE_PROMPT_ITEMS,
    onSelect: item => {
      flow.setWantsCreate(item.id === 'yes');
    },
    onExit: handleExit,
    isActive: flow.phase === 'create-prompt',
  });

  // Checking phase: brief loading state
  if (flow.phase === 'checking') {
    return (
      <Screen title="AgentCore Create" onExit={handleExit}>
        <Text dimColor>Checking for existing project...</Text>
      </Screen>
    );
  }

  // Existing project error phase
  if (flow.phase === 'existing-project-error') {
    return (
      <Screen title="AgentCore Create" onExit={handleExit} helpText="Press Esc to exit">
        <Box marginBottom={1} flexDirection="column">
          <Text color="red">A project already exists at this location.</Text>
          {flow.existingProjectPath && <Text dimColor>Found: {flow.existingProjectPath}</Text>}
          <Box marginTop={1}>
            <Text>
              Use <Text color="cyan">add agent</Text> to create a new agent in the existing project.
            </Text>
          </Box>
        </Box>
      </Screen>
    );
  }

  // Input phase: ask for project name
  if (flow.phase === 'input') {
    return (
      <Screen title="AgentCore Create" onExit={handleExit} helpText={HELP_TEXT.TEXT_INPUT}>
        <Box marginBottom={1} flexDirection="column">
          <Text>Create a new AgentCore project</Text>
          <Text dimColor>This will create a directory with your project name.</Text>
        </Box>
        <TextInput
          prompt="Project name"
          initialValue=""
          schema={ProjectNameSchema}
          onSubmit={name => {
            flow.setProjectName(name);
            flow.confirmProjectName();
          }}
          onCancel={handleExit}
        />
      </Screen>
    );
  }

  // Create prompt phase
  if (flow.phase === 'create-prompt') {
    return (
      <Screen title="AgentCore Create" onExit={handleExit} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Box marginBottom={1}>
          <Text>
            Project: <Text color={STATUS_COLORS.success}>{flow.projectName}</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text>Would you like to add an agent now?</Text>
          <Box marginTop={1}>
            <SelectList items={CREATE_PROMPT_ITEMS} selectedIndex={createPromptIndex} />
          </Box>
        </Box>
      </Screen>
    );
  }

  // Create wizard phase - use AddAgentScreen for consistent experience
  if (flow.phase === 'create-wizard') {
    return (
      <AddAgentScreen
        existingAgentNames={[]}
        onComplete={flow.handleAddAgentComplete}
        onExit={flow.goBackFromAddAgent}
      />
    );
  }

  // Running/complete phase: show progress
  const headerContent = (
    <Box marginTop={1}>
      <Text>
        Project: <Text color={STATUS_COLORS.success}>{flow.projectName}</Text>
      </Text>
    </Box>
  );

  const helpText = flow.hasError || allSuccess ? HELP_TEXT.EXIT : undefined;

  return (
    <Screen title="AgentCore Create" onExit={handleExit} headerContent={headerContent} helpText={helpText}>
      <StepProgress steps={flow.steps} />
      {allSuccess && flow.outputDir && (
        <Box marginTop={1} flexDirection="column">
          <CreatedSummary projectName={flow.projectName} agentConfig={flow.addAgentConfig} />
          {isInteractive ? (
            <Box marginTop={1}>
              <Text color="green">Project created successfully!</Text>
            </Box>
          ) : (
            <NextSteps
              steps={getCreateNextSteps(flow.addAgentConfig !== null)}
              isInteractive={isInteractive}
              onSelect={step => {
                if (onNavigate) {
                  onNavigate({ command: step.command as NextCommand, workingDir: projectRoot });
                }
              }}
              onBack={handleExit}
              isActive={allSuccess}
            />
          )}
        </Box>
      )}
      {flow.hasError && (
        <Box marginTop={1} flexDirection="column">
          <Text color={STATUS_COLORS.error}>Project creation failed.</Text>
          {flow.logFilePath && (
            <Box marginTop={1}>
              <LogLink filePath={flow.logFilePath} />
            </Box>
          )}
        </Box>
      )}
    </Screen>
  );
}
