import type { SelectableItem } from '../../components/SelectList';
import { SelectScreen } from '../../components/SelectScreen';

export type ImportType = 'runtime' | 'memory' | 'evaluator' | 'online-eval' | 'starter-toolkit';

interface ImportSelectItem extends SelectableItem {
  id: ImportType;
}

const IMPORT_OPTIONS: ImportSelectItem[] = [
  {
    id: 'runtime',
    title: 'Runtime',
    description: 'Import an existing AgentCore Runtime from your AWS account',
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Import an existing AgentCore Memory from your AWS account',
  },
  {
    id: 'evaluator',
    title: 'Evaluator',
    description: 'Import an existing AgentCore Evaluator from your AWS account',
  },
  {
    id: 'online-eval',
    title: 'Online Eval Config',
    description: 'Import an existing AgentCore Online Evaluation Config from your AWS account',
  },
  {
    id: 'starter-toolkit',
    title: 'From Starter Toolkit',
    description: 'Import from a .bedrock_agentcore.yaml configuration file',
  },
];

interface ImportSelectScreenProps {
  onSelect: (type: ImportType) => void;
  onExit: () => void;
}

export function ImportSelectScreen({ onSelect, onExit }: ImportSelectScreenProps) {
  return <SelectScreen title="Import" items={IMPORT_OPTIONS} onSelect={item => onSelect(item.id)} onExit={onExit} />;
}
