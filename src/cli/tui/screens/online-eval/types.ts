import type { FilterRule } from '../../../../schema';

// ────────────────────────────────────────────────────────────────────────────
// Online Eval Config Flow Types
// ────────────────────────────────────────────────────────────────────────────

export type AddOnlineEvalStep =
  | 'name'
  | 'agent'
  | 'endpoint'
  | 'evaluators'
  | 'samplingRate'
  | 'sessionTimeoutMinutes'
  | 'filters'
  | 'enableOnCreate'
  | 'confirm';

export interface AddOnlineEvalConfig {
  name: string;
  agent: string;
  endpoint?: string;
  evaluators: string[];
  samplingRate: number;
  /** Session idle timeout in minutes (1-1440). Undefined = use service/CDK default of 5. */
  sessionTimeoutMinutes?: number;
  /** Optional list of trace-level filters (max 20). */
  filters?: FilterRule[];
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
  sessionTimeoutMinutes: 'Timeout',
  filters: 'Filters',
  enableOnCreate: 'Enable',
  confirm: 'Confirm',
};

// ────────────────────────────────────────────────────────────────────────────
// Filter constants for the TUI builder
// ────────────────────────────────────────────────────────────────────────────

export const FILTER_OPERATOR_OPTIONS = [
  'Equals',
  'NotEquals',
  'GreaterThan',
  'LessThan',
  'GreaterThanOrEqual',
  'LessThanOrEqual',
  'Contains',
  'NotContains',
] as const;

export type FilterValueType = 'string' | 'double' | 'boolean';

// ────────────────────────────────────────────────────────────────────────────
// Evaluator Items (fetched from API)
// ────────────────────────────────────────────────────────────────────────────

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
