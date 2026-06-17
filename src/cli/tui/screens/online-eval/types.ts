// ─────────────────────────────────────────────────────────────────────────────
// Online Eval Config Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddOnlineEvalStep =
  | 'name'
  | 'source'
  | 'agent'
  | 'endpoint'
  | 'logGroupNames'
  | 'serviceName'
  | 'evaluators'
  | 'samplingRate'
  | 'enableOnCreate'
  | 'confirm';

export type OnlineEvalSource = 'agentcore-runtime' | 'cloudwatch-logs';

export interface AddOnlineEvalConfig {
  name: string;
  agent: string;
  endpoint?: string;
  logGroupNames?: string[];
  serviceNames?: string[];
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
  source: 'Source',
  agent: 'Agent',
  endpoint: 'Endpoint',
  logGroupNames: 'Log Groups',
  serviceName: 'Services',
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
