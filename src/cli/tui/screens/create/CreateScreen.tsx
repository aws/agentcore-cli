import { DEFAULT_MODEL_IDS, ProjectNameSchema } from '../../../../schema';
import { validateFolderNotExists } from '../../../commands/create/validate';
import { VPC_ENDPOINT_WARNING } from '../../../commands/shared/vpc-utils';
import { computeDefaultCredentialEnvVarName } from '../../../primitives/credential-utils';
import { LogLink, Screen, SelectList, type Step, StepProgress, TextInput } from '../../components';
import { HELP_TEXT } from '../../constants';
import { setExitMessage } from '../../exit-message';
import { useListNavigation } from '../../hooks';
import { STATUS_COLORS } from '../../theme';
import { AddAgentScreen } from '../agent/AddAgentScreen';
import type { AddAgentConfig } from '../agent/types';
import { FRAMEWORK_OPTIONS } from '../agent/types';
import { AddHarnessScreen } from '../harness/AddHarnessScreen';
import type { AddHarnessConfig } from '../harness/types';
import { useCreateFlow } from './useCreateFlow';
import { Box, Text, useApp } from 'ink';
import { useCallback, useEffect } from 'react';

/** Build a text representation of the completion screen for terminal output */
function buildExitMessage(
  projectName: string,
  steps: Step[],
  agentConfig: AddAgentConfig | null,
  harnessConfig: AddHarnessConfig | null
): string {
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
  if (agentConfig?.agentType === 'create' || agentConfig?.agentType === 'import') {
    const frameworkOption = FRAMEWORK_OPTIONS.find(o => o.id === agentConfig.framework);
    const frameworkLabel = frameworkOption?.title ?? agentConfig.framework;
    const modelName = DEFAULT_MODEL_IDS[agentConfig.modelProvider];
    const agentPath = `app/${agentConfig.name}/`;
    const agentcorePath = 'agentcore/';
    const maxPathLen = Math.max(agentPath.length, agentcorePath.length);
    lines.push(`    ${agentPath.padEnd(maxPathLen)}  \x1b[2m${agentConfig.language} agent (${frameworkLabel})\x1b[0m`);
    lines.push(`    ${agentcorePath.padEnd(maxPathLen)}  \x1b[2mConfig and CDK project\x1b[0m`);
    lines.push('');
    lines.push(`\x1b[2mModel:\x1b[0m ${modelName} \x1b[2mvia ${agentConfig.modelProvider}\x1b[0m`);
  } else if (agentConfig?.agentType === 'byo') {
    const agentPath = agentConfig.codeLocation;
    const agentcorePath = 'agentcore/';
    const maxPathLen = Math.max(agentPath.length, agentcorePath.length);
    lines.push(`    ${agentPath.padEnd(maxPathLen)}  \x1b[2mAgent code location (empty)\x1b[0m`);
    lines.push(`    ${agentcorePath.padEnd(maxPathLen)}  \x1b[2mConfig and CDK project\x1b[0m`);
  } else if (harnessConfig) {
    const harnessPath = `app/${harnessConfig.name}/`;
    const agentcorePath = 'agentcore/';
    const maxPathLen = Math.max(harnessPath.length, agentcorePath.length);
    lines.push(`    ${harnessPath.padEnd(maxPathLen)}  \x1b[2mHarness\x1b[0m`);
    lines.push(`    ${agentcorePath.padEnd(maxPathLen)}  \x1b[2mConfig and CDK project\x1b[0m`);
    lines.push('');
    lines.push(`\x1b[2mModel:\x1b[0m ${harnessConfig.modelId} \x1b[2mvia ${harnessConfig.modelProvider}\x1b[0m`);
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

  // VPC endpoint warning
  if (agentConfig?.networkMode === 'VPC') {
    lines.push(`\x1b[33mNote: ${VPC_ENDPOINT_WARNING}\x1b[0m`);
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

const CREATE_TYPE_ITEMS = [
  { id: 'harness', title: 'Harness (recommended)', description: 'Managed config-based agent loop, no code required' },
  {
    id: 'agent',
    title: 'Agent',
    description: 'Start with a template or bring your own code hosted on AgentCore Runtime',
  },
  { id: 'skip', title: 'Skip', description: "I'll add resources later" },
];

/** Tree-style display of created project structure */
function CreatedSummary({
  projectName,
  agentConfig,
  harnessConfig,
}: {
  projectName: string;
  agentConfig: AddAgentConfig | null;
  harnessConfig: AddHarnessConfig | null;
}) {
  const getFrameworkLabel = (framework: string) => {
    const option = FRAMEWORK_OPTIONS.find(o => o.id === framework);
    return option?.title ?? framework;
  };

  const isCreate = agentConfig?.agentType === 'create' || agentConfig?.agentType === 'import';
  const isByo = agentConfig?.agentType === 'byo';
  const agentPath = isCreate ? `app/${agentConfig.name}/` : isByo ? agentConfig.codeLocation : null;
  const harnessPath = harnessConfig ? `app/${harnessConfig.name}/` : null;
  const resourcePath = agentPath ?? harnessPath;
  const agentcorePath = 'agentcore/';
  const maxPathLen = resourcePath ? Math.max(resourcePath.length, agentcorePath.length) : agentcorePath.length;

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
        {harnessConfig && harnessPath && (
          <Box marginLeft={2}>
            <Text>
              {harnessPath.padEnd(maxPathLen)}
              <Text dimColor>{'  '}Harness</Text>
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
      {isCreate && agentConfig && (
        <Box marginTop={1}>
          <Text dimColor>Model: </Text>
          <Text>{DEFAULT_MODEL_IDS[agentConfig.modelProvider]}</Text>
          <Text dimColor> via {agentConfig.modelProvider}</Text>
        </Box>
      )}
      {harnessConfig && (
        <Box marginTop={1}>
          <Text dimColor>Model: </Text>
          <Text>{harnessConfig.modelId}</Text>
          <Text dimColor> via {harnessConfig.modelProvider}</Text>
        </Box>
      )}
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

export function CreateScreen({ cwd, isInteractive, onExit, onNavigate: _onNavigate }: CreateScreenProps) {
  const { exit } = useApp();
  const flow = useCreateFlow(cwd);

  // Completion state for next steps
  const allSuccess = !flow.hasError && flow.isComplete;

  // Handle exit - if successful, exit app completely and print completion screen
  const handleExit = useCallback(() => {
    if (allSuccess && isInteractive) {
      // Set message to be printed after TUI exits (full completion screen)
      setExitMessage(buildExitMessage(flow.projectName, flow.steps, flow.addAgentConfig, flow.addHarnessConfig));
      exit();
    } else {
      onExit();
    }
  }, [
    allSuccess,
    isInteractive,
    flow.projectName,
    flow.steps,
    flow.addAgentConfig,
    flow.addHarnessConfig,
    exit,
    onExit,
  ]);

  // Auto-exit when project creation completes successfully
  useEffect(() => {
    if (allSuccess) {
      handleExit();
    }
  }, [allSuccess, handleExit]);

  // Create type selection navigation
  const { selectedIndex: createTypeIndex } = useListNavigation({
    items: CREATE_TYPE_ITEMS,
    onSelect: item => {
      flow.handleCreateTypeSelection(item.id as 'harness' | 'agent' | 'skip');
    },
    onExit: handleExit,
    isActive: flow.phase === 'create-type-prompt',
  });

  // Checking phase: instant async check — render nothing to avoid a flash before the real UI
  if (flow.phase === 'checking') {
    return null;
  }

  // Create wizard phase - use AddAgentScreen (separate component, no header conflict)
  if (flow.phase === 'create-wizard') {
    return (
      <AddAgentScreen
        existingAgentNames={[]}
        onComplete={flow.handleAddAgentComplete}
        onExit={flow.goBackFromAddAgent}
      />
    );
  }

  // Harness wizard phase (separate component, no header conflict)
  if (flow.phase === 'harness-wizard') {
    return (
      <AddHarnessScreen
        existingHarnessNames={[]}
        onComplete={flow.handleAddHarnessComplete}
        onExit={flow.goBackFromHarnessWizard}
      />
    );
  }

  // All other phases share a single <Screen> to prevent duplicate header flashes
  // when Ink transitions between different <Screen> mounts.
  const phase = flow.phase;
  const showProjectHeader = phase !== 'input' && phase !== 'existing-project-error';
  const headerContent = showProjectHeader ? (
    <Box marginTop={1}>
      <Text>
        Project: <Text color={STATUS_COLORS.success}>{flow.projectName}</Text>
      </Text>
    </Box>
  ) : undefined;

  const helpText =
    phase === 'existing-project-error'
      ? 'Press Esc to exit'
      : phase === 'input'
        ? HELP_TEXT.TEXT_INPUT
        : phase === 'create-type-prompt'
          ? HELP_TEXT.NAVIGATE_SELECT
          : flow.hasError || allSuccess
            ? HELP_TEXT.EXIT
            : undefined;

  return (
    <Screen title="AgentCore Create" onExit={handleExit} headerContent={headerContent} helpText={helpText}>
      {phase === 'existing-project-error' && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="red">A project already exists at this location.</Text>
          {flow.existingProjectPath && <Text dimColor>Found: {flow.existingProjectPath}</Text>}
          <Box marginTop={1}>
            <Text>
              Use <Text color="cyan">add agent</Text> to create a new agent in the existing project.
            </Text>
          </Box>
        </Box>
      )}

      {phase === 'input' && (
        <>
          <Box marginBottom={1} flexDirection="column">
            <Text>Create a new AgentCore project</Text>
            <Text dimColor>This will create a directory with your project name.</Text>
          </Box>
          <TextInput
            prompt="Project name"
            initialValue=""
            schema={ProjectNameSchema}
            customValidation={name => validateFolderNotExists(name, cwd)}
            onSubmit={name => {
              flow.setProjectName(name);
              flow.confirmProjectName();
            }}
            onCancel={handleExit}
          />
        </>
      )}

      {phase === 'create-type-prompt' && (
        <>
          <Box flexDirection="column">
            <Text>What would you like to build?</Text>
            <Box marginTop={1}>
              <SelectList items={CREATE_TYPE_ITEMS} selectedIndex={createTypeIndex} />
            </Box>
          </Box>
        </>
      )}

      {phase === 'running' && <StepProgress steps={flow.steps} />}

      {allSuccess && flow.outputDir && (
        <Box marginTop={1} flexDirection="column">
          <StepProgress steps={flow.steps} />
          <CreatedSummary
            projectName={flow.projectName}
            agentConfig={flow.addAgentConfig}
            harnessConfig={flow.addHarnessConfig}
          />
          <Box marginTop={1}>
            <Text color="green">Project created successfully!</Text>
          </Box>
          {!isInteractive && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>To continue, navigate to your new project:</Text>
              <Text>
                {'\n'} cd {flow.projectName}
              </Text>
              <Text> agentcore</Text>
            </Box>
          )}
        </Box>
      )}

      {flow.hasError && (
        <Box marginTop={1} flexDirection="column">
          <StepProgress steps={flow.steps} />
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
