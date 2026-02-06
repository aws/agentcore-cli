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
}

export function AddAgentFlow({ existingAgentNames, onComplete, onBack }: AddAgentFlowProps) {
  return <AddAgentScreen existingAgentNames={existingAgentNames} onComplete={onComplete} onExit={onBack} />;
}
