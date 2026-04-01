import { Panel } from '../../components/Panel';
import { Screen } from '../../components/Screen';
import { TextInput } from '../../components/TextInput';
import { HELP_TEXT } from '../../constants';

const ARN_PATTERN = /^arn:aws:bedrock-agentcore:[^:]+:[^:]+:(runtime|memory)\/.+$/;

function validateArn(value: string): true | string {
  if (!ARN_PATTERN.test(value)) {
    return 'Invalid ARN format. Expected: arn:aws:bedrock-agentcore:<region>:<account>:<runtime|memory>/<id>';
  }
  return true;
}

interface ArnInputScreenProps {
  resourceType: 'runtime' | 'memory';
  onSubmit: (arn: string) => void;
  onExit: () => void;
}

export function ArnInputScreen({ resourceType, onSubmit, onExit }: ArnInputScreenProps) {
  const title = resourceType === 'runtime' ? 'Import Runtime' : 'Import Memory';
  const placeholder = `arn:aws:bedrock-agentcore:<region>:<account>:${resourceType}/<id>`;

  return (
    <Screen title={title} onExit={onExit} helpText={HELP_TEXT.TEXT_INPUT}>
      <Panel>
        <TextInput
          prompt="Enter the resource ARN:"
          placeholder={placeholder}
          onSubmit={onSubmit}
          onCancel={onExit}
          customValidation={validateArn}
        />
      </Panel>
    </Screen>
  );
}
