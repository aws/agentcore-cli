import { ProjectNameSchema } from '../../../../schema';
import { LogLink, type NextStep, NextSteps, Screen, SelectList, StepProgress, TextInput } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { STATUS_COLORS } from '../../theme';
import { AddAgentScreen } from '../agent/AddAgentScreen';
import type { AddAgentConfig } from '../agent/types';
import { FRAMEWORK_OPTIONS } from '../agent/types';
import { useCreateFlow } from './useCreateFlow';
import { Box, Text } from 'ink';
import { join } from 'path';

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

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Created:</Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text>{projectName}/</Text>
        {agentConfig?.agentType === 'create' && (
          <Box marginLeft={2}>
            <Text>
              app/{agentConfig.name}/
              <Text dimColor>
                {'  '}
                {agentConfig.language} agent ({getFrameworkLabel(agentConfig.framework)})
              </Text>
            </Text>
          </Box>
        )}
        <Box marginLeft={2}>
          <Text>
            agentcore/<Text dimColor>{'         '}Config and CDK project</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export function CreateScreen({ cwd, isInteractive, onExit, onNavigate }: CreateScreenProps) {
  const flow = useCreateFlow(cwd);
  // Project root is cwd/projectName (new project directory)
  const projectRoot = join(cwd, flow.projectName);

  // Create prompt navigation
  const { selectedIndex: createPromptIndex } = useListNavigation({
    items: CREATE_PROMPT_ITEMS,
    onSelect: item => {
      flow.setWantsCreate(item.id === 'yes');
    },
    onExit,
    isActive: flow.phase === 'create-prompt',
  });

  // Completion state for next steps
  const allSuccess = !flow.hasError && flow.isComplete;

  // Checking phase: brief loading state
  if (flow.phase === 'checking') {
    return (
      <Screen title="AgentCore Create" onExit={onExit}>
        <Text dimColor>Checking for existing project...</Text>
      </Screen>
    );
  }

  // Existing project error phase
  if (flow.phase === 'existing-project-error') {
    return (
      <Screen title="AgentCore Create" onExit={onExit} helpText="Press Esc to exit">
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
      <Screen title="AgentCore Create" onExit={onExit} helpText={HELP_TEXT.TEXT_INPUT}>
        <Box marginBottom={1}>
          <Text>Create a new AgentCore project</Text>
        </Box>
        <TextInput
          prompt="Project name"
          initialValue={flow.projectName}
          schema={ProjectNameSchema}
          onSubmit={name => {
            flow.setProjectName(name);
            flow.confirmProjectName();
          }}
          onCancel={onExit}
        />
      </Screen>
    );
  }

  // Create prompt phase
  if (flow.phase === 'create-prompt') {
    return (
      <Screen title="AgentCore Create" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT}>
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
    <Screen title="AgentCore Create" onExit={onExit} headerContent={headerContent} helpText={helpText}>
      <StepProgress steps={flow.steps} />
      {allSuccess && flow.outputDir && (
        <Box marginTop={1} flexDirection="column">
          <CreatedSummary projectName={flow.projectName} agentConfig={flow.addAgentConfig} />
          {isInteractive ? (
            <Box marginTop={1} flexDirection="column">
              <Text color="green">Project created successfully!</Text>
              <Box marginTop={1} flexDirection="column">
                <Text>To continue, exit and navigate to your new project:</Text>
                <Box marginLeft={2} marginTop={1} flexDirection="column">
                  <Text>
                    <Text color="cyan">1.</Text> Press <Text color="cyan">Esc</Text> to exit
                  </Text>
                  <Text>
                    <Text color="cyan">2.</Text> Run <Text color="cyan">cd {flow.projectName}</Text>
                  </Text>
                  <Text>
                    <Text color="cyan">3.</Text> Run <Text color="cyan">agentcore</Text> to continue
                  </Text>
                </Box>
              </Box>
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
              onBack={onExit}
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
