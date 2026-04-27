import type { ImportableResourceType } from '../../../commands/import/types';
import { Panel } from '../../components/Panel';
import { Screen } from '../../components/Screen';
import { TextInput } from '../../components/TextInput';
import { HELP_TEXT } from '../../constants';

const ARN_PATTERN =
  /^arn:[^:]+:bedrock-agentcore:[^:]+:[^:]+:(runtime|memory|evaluator|online-evaluation-config|gateway)\/.+$/;

function validateArn(value: string): true | string {
  if (!ARN_PATTERN.test(value)) {
    return 'Invalid ARN format. Expected: arn:<partition>:bedrock-agentcore:<region>:<account>:<resource-type>/<id>';
  }
  return true;
}

interface ArnInputScreenProps {
  resourceType: ImportableResourceType;
  onSubmit: (arn: string) => void;
  onExit: () => void;
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  runtime: 'Import Runtime',
  memory: 'Import Memory',
  evaluator: 'Import Evaluator',
  'online-eval': 'Import Online Eval Config',
  gateway: 'Import Gateway',
};

export function ArnInputScreen({ resourceType, onSubmit, onExit }: ArnInputScreenProps) {
  const title = RESOURCE_TYPE_LABELS[resourceType] ?? `Import ${resourceType}`;
  const arnResourceType = resourceType === 'online-eval' ? 'online-evaluation-config' : resourceType;
  const placeholder = `arn:<partition>:bedrock-agentcore:<region>:<account>:${arnResourceType}/<id>`;

  return (
    <Screen title={title} onExit={onExit} helpText={HELP_TEXT.TEXT_INPUT}>
      <Panel>
        <TextInput
          prompt="Enter the resource ARN:"
          placeholder={placeholder}
          onSubmit={onSubmit}
          onCancel={onExit}
          customValidation={validateArn}
          expandable
        />
      </Panel>
    </Screen>
  );
}
