import { Panel } from '../../components/Panel';
import { PathInput } from '../../components/PathInput';
import { Screen } from '../../components/Screen';
import { Text } from 'ink';

interface CodePathScreenProps {
  onSubmit: (codePath: string) => void;
  onExit: () => void;
}

export function CodePathScreen({ onSubmit, onExit }: CodePathScreenProps) {
  return (
    <Screen title="Agent Source Code" onExit={onExit} exitEnabled={false}>
      <Panel>
        <Text dimColor>Path to the directory containing your entrypoint file</Text>
        <PathInput pathType="directory" placeholder="app/my-agent/" onSubmit={onSubmit} onCancel={onExit} />
      </Panel>
    </Screen>
  );
}
