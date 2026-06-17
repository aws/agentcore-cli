import type {
  RecommendationInputSource as RecommendationInputSourceKind,
  RecommendationType,
  RecommendationTraceSource as TraceSourceKind,
} from '../../../operations/jobs';

export type RecommendationStep =
  | 'type'
  | 'agent'
  | 'evaluator'
  | 'inputSource'
  | 'content'
  | 'bundle'
  | 'bundleField'
  | 'tools'
  | 'traceSource'
  | 'days'
  | 'sessions'
  | 'kms-key-arn'
  | 'confirm';

export interface RecommendationWizardConfig {
  type: RecommendationType;
  agent: string;
  evaluators: string[];
  inputSource: RecommendationInputSourceKind;
  content: string;
  tools: string;
  traceSource: TraceSourceKind;
  days: number;
  sessionIds: string[];
  bundleName: string;
  bundleVersion: string;
  bundleFields: string[];
  /** JSONPath for system prompt within the config bundle (set when user picks a field) */
  systemPromptJsonPath: string;
  /** Tool name → JSONPath pairs for tool descriptions within the config bundle */
  toolDescJsonPaths: { toolName: string; toolDescriptionJsonPath: string }[];
  /** KMS key ARN for encrypting recommendation results */
  kmsKeyArn: string;
}

export const RECOMMENDATION_STEP_LABELS: Record<RecommendationStep, string> = {
  type: 'Type',
  agent: 'Agent',
  evaluator: 'Evaluator',
  inputSource: 'Source',
  content: 'Content',
  bundle: 'Bundle',
  bundleField: 'Fields',
  tools: 'Tools',
  traceSource: 'Traces',
  days: 'Lookback',
  sessions: 'Sessions',
  'kms-key-arn': 'KMS Key',
  confirm: 'Confirm',
};

export const DEFAULT_LOOKBACK_DAYS = 7;

export interface AgentItem {
  name: string;
  runtimeId: string;
  runtimeArn: string;
}

export interface EvaluatorItem {
  id: string;
  title: string;
  description: string;
}

/** A string field found at an arbitrary depth inside a config bundle's JSON. */
export interface ConfigBundleField {
  /** Dot-notation path from the bundle root, e.g. "components.myAgent.configuration.systemPrompt" */
  path: string;
  /** JSONPath expression for the API, e.g. "$.components.myAgent.configuration.systemPrompt" */
  jsonPath: string;
  /** The string value at this path */
  value: string;
}

export interface ConfigBundleItem {
  name: string;
  bundleId: string;
  bundleArn: string;
  versionId: string;
  /** All string-valued fields found recursively across the bundle's components. */
  fields: ConfigBundleField[];
}
