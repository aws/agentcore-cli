// ──────────────────────────────────────────────────────────────────────────────
// Online Eval Config Flow Types
// ──────────────────────────────────────────────────────────────────────────────

import type { OnlineEvalFilter, OnlineEvalFilterOperator } from '../../../../schema';

export type AddOnlineEvalStep =
  | 'name'
  | 'agent'
  | 'endpoint'
  | 'evaluators'
  | 'samplingRate'
  | 'sessionTimeout'
  | 'filters'
  | 'enableOnCreate'
  | 'confirm';

export interface AddOnlineEvalConfig {
  name: string;
  agent: string;
  endpoint?: string;
  evaluators: string[];
  samplingRate: number;
  sessionTimeoutMinutes?: number;
  filters?: OnlineEvalFilter[];
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
  sessionTimeout: 'Timeout',
  filters: 'Filters',
  enableOnCreate: 'Enable',
  confirm: 'Confirm',
};

/** Filter operators offered in the wizard. */
export const ONLINE_EVAL_FILTER_OPERATORS: OnlineEvalFilterOperator[] = [
  'Equals',
  'NotEquals',
  'GreaterThan',
  'LessThan',
  'GreaterThanOrEqual',
  'LessThanOrEqual',
  'Contains',
  'NotContains',
];

// ──────────────────────────────────────────────────────────────────────────────
// Evaluator Items (fetched from API)
// ──────────────────────────────────────────────────────────────────────────────

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
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 5;
