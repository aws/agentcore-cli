import { Panel } from '../../components/Panel';
import { PathInput } from '../../components/PathInput';
import { Screen } from '../../components/Screen';
import { Text } from 'ink';

interface YamlPathScreenProps {
  onSubmit: (yamlPath: string) => void;
  onExit: () => void;
}

export function YamlPathScreen({ onSubmit, onExit }: YamlPathScreenProps) {
  return (
    <Screen title="Starter Toolkit Config" onExit={onExit} exitEnabled={false}>
      <Panel>
        <Text dimColor>Path to the .bedrock_agentcore.yaml file</Text>
        <PathInput
          pathType="file"
          placeholder=".bedrock_agentcore.yaml"
          showHidden={true}
          onSubmit={onSubmit}
          onCancel={onExit}
        />
      </Panel>
    </Screen>
  );
}
