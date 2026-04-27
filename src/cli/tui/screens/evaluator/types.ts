import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type EvaluatorTypeId = 'code-based' | 'llm-as-a-judge';
export type CodeBasedTypeId = 'managed' | 'external';

export type AddEvaluatorStep =
  | 'evaluator-type'
  | 'code-based-type'
  | 'name'
  | 'level'
  | 'model'
  | 'model-custom'
  | 'instructions'
  | 'ratingScale'
  | 'ratingScale-type'
  | 'ratingScale-custom'
  | 'lambda-arn'
  | 'timeout'
  | 'kms-key-arn'
  | 'confirm';

export interface AddEvaluatorConfig {
  name: string;
  level: EvaluationLevel;
  config: EvaluatorConfig;
  kmsKeyArn?: string;
}

export const EVALUATOR_STEP_LABELS: Record<AddEvaluatorStep, string> = {
  'evaluator-type': 'Type',
  'code-based-type': 'Mode',
  name: 'Name',
  level: 'Level',
  model: 'Model',
  'model-custom': 'Model',
  instructions: 'Prompt',
  ratingScale: 'Scale',
  'ratingScale-type': 'Scale',
  'ratingScale-custom': 'Scale',
  'lambda-arn': 'Lambda',
  timeout: 'Timeout',
  'kms-key-arn': 'KMS Key',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Type Options
// ─────────────────────────────────────────────────────────────────────────────

export const EVALUATOR_TYPE_OPTIONS = [
  {
    id: 'code-based',
    title: 'Code-based (custom Lambda function)',
    description: 'Write custom Python code for evaluation logic',
  },
  {
    id: 'llm-as-a-judge',
    title: 'LLM-as-a-Judge (model-based)',
    description: 'Use a foundation model to evaluate quality',
  },
] as const;

export const CODE_BASED_TYPE_OPTIONS = [
  {
    id: 'managed',
    title: 'Create new (CLI scaffolds and deploys the Lambda for you)',
    description: 'CLI scaffolds code and deploys Lambda',
  },
  { id: 'external', title: 'Existing Lambda ARN (bring your own)', description: 'Use an existing Lambda function' },
] as const;

export const DEFAULT_CODE_TIMEOUT = 60;
export const DEFAULT_CODE_ENTRYPOINT = 'lambda_function.handler';

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const EVALUATION_LEVEL_OPTIONS = [
  { id: 'SESSION', title: 'Session', description: 'Overall quality across an entire conversation' },
  { id: 'TRACE', title: 'Trace', description: 'Per-turn accuracy of individual agent responses' },
  { id: 'TOOL_CALL', title: 'Tool Call', description: 'Correctness of individual tool selections and usage' },
] as const;

// Cross-region inference profile ID — works in all US regions where AgentCore is available
export const DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export const CUSTOM_MODEL_ID = '__custom__';

export interface EvaluatorModelOption {
  id: string;
  title: string;
  description: string;
}

export const EVALUATOR_MODEL_OPTIONS: EvaluatorModelOption[] = [
  {
    id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    title: 'Claude Sonnet 4.5',
    description: 'Recommended — balanced speed and accuracy',
  },
  {
    id: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
    title: 'Claude Opus 4.5',
    description: 'Most capable — best for complex evaluations',
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    title: 'Claude Haiku 4.5',
    description: 'Fastest — good for high-volume evaluations',
  },
  {
    id: 'us.amazon.nova-pro-v1:0',
    title: 'Amazon Nova Pro',
    description: 'Amazon foundation model — strong reasoning',
  },
  {
    id: 'us.amazon.nova-lite-v1:0',
    title: 'Amazon Nova Lite',
    description: 'Amazon foundation model — fast and cost-effective',
  },
  {
    id: CUSTOM_MODEL_ID,
    title: 'Other',
    description: 'Enter a custom Bedrock model ID or ARN',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed placeholders per evaluation level. The API requires instructions
 * to contain at least one placeholder from the evaluator's level.
 */
export const LEVEL_PLACEHOLDERS: Record<EvaluationLevel, string[]> = {
  SESSION: ['context', 'available_tools'],
  TRACE: ['context', 'assistant_turn'],
  TOOL_CALL: ['available_tools', 'context', 'tool_turn'],
};

/**
 * Reference input placeholders per evaluation level. These are populated by the caller
 * at eval time via evaluationReferenceInputs — if not provided, they resolve to empty.
 */
export const REFERENCE_INPUT_PLACEHOLDERS: Record<EvaluationLevel, string[]> = {
  SESSION: ['assertions', 'expected_tool_trajectory', 'actual_tool_trajectory'],
  TRACE: ['expected_response'],
  TOOL_CALL: [],
};

/** Human-readable descriptions of what each placeholder expands to at eval time. */
export const PLACEHOLDER_DESCRIPTIONS: Record<string, string> = {
  context: 'full conversation history (user + assistant messages)',
  assistant_turn: 'the specific assistant response being evaluated',
  available_tools: 'list of tools the agent can call',
  tool_turn: 'the specific tool call and its result',
  assertions: 'caller-provided assertions the agent should satisfy',
  expected_tool_trajectory: 'caller-provided expected sequence of tool calls',
  actual_tool_trajectory: 'actual sequence of tool calls from the session',
  expected_response: 'caller-provided expected agent response',
};

/**
 * Default instruction templates per level that include required placeholders.
 */
export const DEFAULT_INSTRUCTIONS: Record<EvaluationLevel, string> = {
  SESSION:
    'Evaluate the agent session. Context: {context}. Available tools: {available_tools}. The agent must satisfy: {assertions}. Expected trajectory: {expected_tool_trajectory}. Actual trajectory: {actual_tool_trajectory}. Rate the overall quality.',
  TRACE:
    'Evaluate the agent trace. Context: {context}. Assistant turn: {assistant_turn}. Expected response: {expected_response}. Rate the quality of this response.',
  TOOL_CALL: 'Evaluate the tool call. Context: {context}. Tool turn: {tool_turn}. Rate the quality of this tool usage.',
};

/**
 * Validates that instructions contain at least one placeholder for the given level.
 */
export function validateInstructionPlaceholders(instructions: string, level: EvaluationLevel): string | true {
  const placeholders = LEVEL_PLACEHOLDERS[level];
  const hasPlaceholder = placeholders.some(p => instructions.includes(`{${p}}`));
  if (!hasPlaceholder) {
    return `Instructions must contain at least one placeholder: ${placeholders.map(p => `{${p}}`).join(', ')}`;
  }
  return true;
}

export interface RatingScalePreset {
  id: string;
  title: string;
  description: string;
  ratingScale: NonNullable<EvaluatorConfig['llmAsAJudge']>['ratingScale'];
}

export const CUSTOM_RATING_SCALE_ID = '__custom__';

export type CustomRatingScaleType = 'numerical' | 'categorical';

export const RATING_SCALE_TYPE_OPTIONS = [
  { id: 'numerical', title: 'Numerical', description: 'Scored values (e.g. 1–5)' },
  { id: 'categorical', title: 'Categorical', description: 'Named labels (e.g. Pass/Fail)' },
] as const;

/**
 * Parse a custom rating scale from compact text format.
 * Numerical: "1:Poor:Fails to meet, 2:Fair:Partially meets, 5:Excellent:Far exceeds"
 * Categorical: "Pass:Meets criteria, Fail:Does not meet"
 */
export function parseCustomRatingScale(
  input: string,
  type: CustomRatingScaleType
):
  | { success: true; ratingScale: NonNullable<EvaluatorConfig['llmAsAJudge']>['ratingScale'] }
  | { success: false; error: string } {
  const entries = input
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  if (entries.length < 2) {
    return { success: false, error: 'At least 2 entries required (comma-separated)' };
  }

  if (type === 'numerical') {
    const numerical: { value: number; label: string; definition: string }[] = [];
    for (const entry of entries) {
      const firstColon = entry.indexOf(':');
      const secondColon = firstColon >= 0 ? entry.indexOf(':', firstColon + 1) : -1;
      if (firstColon < 0 || secondColon < 0) {
        return { success: false, error: `Invalid entry "${entry}". Format: value:label:definition` };
      }
      const rawValue = entry.slice(0, firstColon).trim();
      const value = Number(rawValue);
      if (isNaN(value)) {
        return { success: false, error: `"${rawValue}" is not a valid number in "${entry}"` };
      }
      const label = entry.slice(firstColon + 1, secondColon).trim();
      const definition = entry.slice(secondColon + 1).trim();
      numerical.push({ value, label, definition });
    }
    return { success: true, ratingScale: { numerical } };
  }

  const categorical: { label: string; definition: string }[] = [];
  for (const entry of entries) {
    const firstColon = entry.indexOf(':');
    if (firstColon < 0) {
      return { success: false, error: `Invalid entry "${entry}". Format: label:definition` };
    }
    const label = entry.slice(0, firstColon).trim();
    const definition = entry.slice(firstColon + 1).trim();
    categorical.push({ label, definition });
  }
  return { success: true, ratingScale: { categorical } };
}

export const RATING_SCALE_PRESETS: RatingScalePreset[] = [
  {
    id: '1-5-quality',
    title: '1–5 Quality',
    description: 'Numerical · Poor(1), Fair(2), Good(3), Very Good(4), Excellent(5)',
    ratingScale: {
      numerical: [
        { value: 1, label: 'Poor', definition: 'Fails to meet expectations' },
        { value: 2, label: 'Fair', definition: 'Partially meets expectations' },
        { value: 3, label: 'Good', definition: 'Meets expectations' },
        { value: 4, label: 'Very Good', definition: 'Exceeds expectations' },
        { value: 5, label: 'Excellent', definition: 'Far exceeds expectations' },
      ],
    },
  },
  {
    id: '1-3-simple',
    title: '1–3 Simple',
    description: 'Numerical · Low(1), Medium(2), High(3)',
    ratingScale: {
      numerical: [
        { value: 1, label: 'Low', definition: 'Below acceptable quality' },
        { value: 2, label: 'Medium', definition: 'Acceptable quality' },
        { value: 3, label: 'High', definition: 'Above acceptable quality' },
      ],
    },
  },
  {
    id: 'pass-fail',
    title: 'Pass / Fail',
    description: 'Categorical · binary pass or fail assessment',
    ratingScale: {
      categorical: [
        { label: 'Pass', definition: 'Meets the evaluation criteria' },
        { label: 'Fail', definition: 'Does not meet the evaluation criteria' },
      ],
    },
  },
  {
    id: 'good-neutral-bad',
    title: 'Good / Neutral / Bad',
    description: 'Categorical · three-tier quality assessment',
    ratingScale: {
      categorical: [
        { label: 'Good', definition: 'Positive outcome, meets or exceeds criteria' },
        { label: 'Neutral', definition: 'Acceptable but unremarkable outcome' },
        { label: 'Bad', definition: 'Negative outcome, fails to meet criteria' },
      ],
    },
  },
];
