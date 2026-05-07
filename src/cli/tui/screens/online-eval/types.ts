// ─────────────────────────────────────────────────────────────────────────────
// Online Eval Config Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddOnlineEvalStep =
  | 'name'
  | 'agent'
  | 'endpoint'
  | 'evaluators'
  | 'samplingRate'
  | 'enableOnCreate'
  | 'confirm';

export interface AddOnlineEvalConfig {
  name: string;
  agent: string;
  endpoint?: string;
  evaluators: string[];
  samplingRate: number;
  enableOnCreate: boolean;
  description?: string;
}

/** Runtime endpoint info used by the online eval endpoint picker. */
export interface RuntimeEndpointEntry {
  name: string;
  version: number;
}

export const ONLINE_EVAL_STEP_LABELS: Record<AddOnlineEvalStep, string> = {
  name: 'Name',
  agent: 'Agent',
  endpoint: 'Endpoint',
  evaluators: 'Evaluators',
  samplingRate: 'Rate',
  enableOnCreate: 'Enable',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Items (fetched from API)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluatorItem {
  /** ARN used as the stored identifier in the config */
  arn: string;
  /** Display name */
  name: string;
  /** 'Builtin' or 'Custom' */
  type: string;
  /** Optional description */
  description?: string;
}

export const DEFAULT_SAMPLING_RATE = 10;
