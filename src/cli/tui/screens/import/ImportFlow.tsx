import {
  IMPORTABLE_RESOURCES,
  type ImportResourceResult,
  type ImportResult,
  type ImportableResourceType,
} from '../../../commands/import/types';
import { type NextStep, NextSteps } from '../../components/NextSteps';
import { Panel } from '../../components/Panel';
import { ErrorPrompt } from '../../components/PromptScreen';
import { Screen } from '../../components/Screen';
import { HELP_TEXT } from '../../constants';
import { ArnInputScreen } from './ArnInputScreen';
import { CodePathScreen } from './CodePathScreen';
import { ImportProgressScreen } from './ImportProgressScreen';
import { ImportSelectScreen, type ImportType } from './ImportSelectScreen';
import { YamlPathScreen } from './YamlPathScreen';
import { Box, Text } from 'ink';
import React, { useState } from 'react';

type ImportFlowState =
  | { name: 'select-type' }
  | { name: 'arn-input'; resourceType: ImportableResourceType }
  | { name: 'code-path'; resourceType: 'runtime'; arn: string }
  | { name: 'yaml-path' }
  | {
      name: 'importing';
      importType: ImportType;
      arn?: string;
      code?: string;
      yamlPath?: string;
    }
  | {
      name: 'success';
      importType: ImportType;
      result: ImportResourceResult | ImportResult;
    }
  | { name: 'error'; message: string };

const IMPORT_NEXT_STEPS: NextStep[] = [
  { command: 'deploy', label: 'Deploy the imported stack' },
  { command: 'status', label: 'Verify resource status' },
];

interface ImportFlowProps {
  onBack: () => void;
  onNavigate?: (command: string) => void;
}

export function ImportFlow({ onBack, onNavigate }: ImportFlowProps) {
  const [flow, setFlow] = useState<ImportFlowState>({ name: 'select-type' });

  if (flow.name === 'select-type') {
    return (
      <ImportSelectScreen
        onSelect={type => {
          if ((IMPORTABLE_RESOURCES as readonly string[]).includes(type)) {
            setFlow({ name: 'arn-input', resourceType: type as ImportableResourceType });
          } else {
            setFlow({ name: 'yaml-path' });
          }
        }}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'arn-input') {
    return (
      <ArnInputScreen
        resourceType={flow.resourceType}
        onSubmit={arn => {
          if (flow.resourceType === 'runtime') {
            setFlow({ name: 'code-path', resourceType: 'runtime', arn });
          } else {
            setFlow({
              name: 'importing',
              importType: flow.resourceType,
              arn,
            });
          }
        }}
        onExit={() => setFlow({ name: 'select-type' })}
      />
    );
  }

  if (flow.name === 'code-path') {
    return (
      <CodePathScreen
        onSubmit={codePath => {
          setFlow({
            name: 'importing',
            importType: 'runtime',
            arn: flow.arn,
            code: codePath,
          });
        }}
        onExit={() => setFlow({ name: 'arn-input', resourceType: 'runtime' })}
      />
    );
  }

  if (flow.name === 'yaml-path') {
    return (
      <YamlPathScreen
        onSubmit={yamlPath => {
          setFlow({
            name: 'importing',
            importType: 'starter-toolkit',
            yamlPath,
          });
        }}
        onExit={() => setFlow({ name: 'select-type' })}
      />
    );
  }

  if (flow.name === 'importing') {
    return (
      <ImportProgressScreen
        importType={flow.importType}
        arn={flow.arn}
        code={flow.code}
        yamlPath={flow.yamlPath}
        onSuccess={result => {
          setFlow({ name: 'success', importType: flow.importType, result });
        }}
        onError={message => {
          setFlow({ name: 'error', message });
        }}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'success') {
    const result = flow.result;

    return (
      <Screen title="Import Complete" onExit={onBack} helpText={HELP_TEXT.BACK}>
        <Panel>
          <Box flexDirection="column">
            <Text color="green">Import successful!</Text>
            {'resourceType' in result && (
              <Box flexDirection="column" marginTop={1}>
                <Text>
                  <Text dimColor>Type: </Text>
                  <Text>{result.resourceType}</Text>
                </Text>
                <Text>
                  <Text dimColor>Name: </Text>
                  <Text>{result.resourceName}</Text>
                </Text>
                {'resourceId' in result && result.resourceId && (
                  <Text>
                    <Text dimColor>ID: </Text>
                    <Text>{result.resourceId}</Text>
                  </Text>
                )}
              </Box>
            )}
            {'importedAgents' in result && (
              <Box flexDirection="column" marginTop={1}>
                {result.importedAgents?.map(agent => (
                  <Text key={agent}>
                    <Text dimColor>Agent: </Text>
                    <Text>{agent}</Text>
                  </Text>
                ))}
                {result.importedMemories?.map(mem => (
                  <Text key={mem}>
                    <Text dimColor>Memory: </Text>
                    <Text>{mem}</Text>
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        </Panel>
        <NextSteps
          steps={IMPORT_NEXT_STEPS}
          isInteractive={true}
          onSelect={step => (onNavigate ? onNavigate(step.command) : onBack())}
          onBack={onBack}
        />
      </Screen>
    );
  }

  if (flow.name === 'error') {
    return (
      <ErrorPrompt
        message="Import failed"
        detail={flow.message}
        onBack={() => setFlow({ name: 'select-type' })}
        onExit={onBack}
      />
    );
  }

  return null;
}
