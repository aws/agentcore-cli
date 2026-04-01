import type { ImportResult, ImportResourceResult } from '../../../commands/import/types';
import { ErrorPrompt } from '../../components/PromptScreen';
import { NextSteps, type NextStep } from '../../components/NextSteps';
import { Screen } from '../../components/Screen';
import { Panel } from '../../components/Panel';
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
  | { name: 'arn-input'; resourceType: 'runtime' | 'memory' }
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
}

export function ImportFlow({ onBack }: ImportFlowProps) {
  const [flow, setFlow] = useState<ImportFlowState>({ name: 'select-type' });

  if (flow.name === 'select-type') {
    return (
      <ImportSelectScreen
        onSelect={(type) => {
          if (type === 'runtime' || type === 'memory') {
            setFlow({ name: 'arn-input', resourceType: type });
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
        onSubmit={(arn) => {
          if (flow.resourceType === 'runtime') {
            setFlow({ name: 'code-path', resourceType: 'runtime', arn });
          } else {
            setFlow({
              name: 'importing',
              importType: 'memory',
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
        onSubmit={(codePath) => {
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
        onSubmit={(yamlPath) => {
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
        onSuccess={(result) => {
          setFlow({ name: 'success', importType: flow.importType, result });
        }}
        onError={(message) => {
          setFlow({ name: 'error', message });
        }}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'success') {
    const result = flow.result;
    const isResource = 'resourceType' in result;

    return (
      <Screen title="Import Complete" onExit={onBack} helpText={HELP_TEXT.BACK}>
        <Panel>
          <Box flexDirection="column">
            <Text color="green">Import successful!</Text>
            {isResource && (
              <Box flexDirection="column" marginTop={1}>
                <Text>
                  <Text dimColor>Type: </Text>
                  <Text>{(result as ImportResourceResult).resourceType}</Text>
                </Text>
                <Text>
                  <Text dimColor>Name: </Text>
                  <Text>{(result as ImportResourceResult).resourceName}</Text>
                </Text>
                {(result as ImportResourceResult).resourceId && (
                  <Text>
                    <Text dimColor>ID: </Text>
                    <Text>{(result as ImportResourceResult).resourceId}</Text>
                  </Text>
                )}
              </Box>
            )}
            {!isResource && (
              <Box flexDirection="column" marginTop={1}>
                {(result as ImportResult).importedAgents?.map((agent) => (
                  <Text key={agent}>
                    <Text dimColor>Agent: </Text>
                    <Text>{agent}</Text>
                  </Text>
                ))}
                {(result as ImportResult).importedMemories?.map((mem) => (
                  <Text key={mem}>
                    <Text dimColor>Memory: </Text>
                    <Text>{mem}</Text>
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        </Panel>
        <NextSteps steps={IMPORT_NEXT_STEPS} isInteractive={true} onSelect={() => onBack()} onBack={onBack} />
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
