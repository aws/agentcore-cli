import { AddAgentScreen } from './AddAgentScreen';
import type { AddAgentConfig } from './types';

interface AddAgentFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  /** Existing agent names */
  existingAgentNames: string[];
  /** Callback when an agent is created (create or byo) */
  onComplete: (config: AddAgentConfig) => void;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddAgentFlow({ existingAgentNames, onComplete, onBack, onDeploy: _onDeploy }: AddAgentFlowProps) {
  return <AddAgentScreen existingAgentNames={existingAgentNames} onComplete={onComplete} onExit={onBack} />;
}
