/** Result of a single evaluator within an eval run */
export interface EvalEvaluatorResult {
  evaluator: string;
  aggregateScore: number;
  sessionScores: EvalSessionScore[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** Per-session score from an evaluator */
export interface EvalSessionScore {
  sessionId: string;
  traceId?: string;
  spanId?: string;
  value: number;
  label?: string;
  explanation?: string;
  errorMessage?: string;
}

/** Full eval run result stored to disk */
export interface EvalRunResult {
  timestamp: string;
  agent: string;
  evaluators: string[];
  lookbackDays: number;
  sessionCount: number;
  results: EvalEvaluatorResult[];
  referenceInputs?: {
    assertions?: string[];
    expectedTrajectory?: string[];
    expectedResponse?: string;
  };
}

/** Lightweight session info returned by session discovery */
export interface SessionInfo {
  sessionId: string;
  spanCount: number;
  firstSeen: string;
}

/** Options for running an eval */
export interface RunEvalOptions {
  /** Agent name (project mode) */
  agent?: string;
  /** Evaluator names or Builtin.* IDs (resolved via project deployed state) */
  evaluator: string[];
  /** Evaluator ARN(s) or IDs passed directly */
  evaluatorArn?: string[];
  /** Agent runtime ARN (ARN mode — bypasses project config) */
  agentArn?: string;
  /** AWS region (required with --agent-arn, inferred otherwise) */
  region?: string;
  /** Filter to a specific session */
  sessionId?: string;
  /** Filter to specific session IDs (from TUI multi-select) */
  sessionIds?: string[];
  /** Filter to a specific trace */
  traceId?: string;
  /** Runtime endpoint name (e.g. PROMPT_V1). Defaults to AGENTCORE_RUNTIME_ENDPOINT env var, then DEFAULT. */
  endpoint?: string;
  /** Assertions the agent should satisfy (repeatable) */
  assertions?: string[];
  /** Expected tool call names in order (repeatable) */
  expectedTrajectory?: string[];
  /** Expected agent response text */
  expectedResponse?: string;
  days: number;
  output?: string;
  json?: boolean;
}

/** Options for listing eval runs */
export interface ListEvalRunsOptions {
  agent?: string;
  limit?: number;
  json?: boolean;
}

/** Options for pause/resume online eval */
export interface OnlineEvalActionOptions {
  name: string;
  /** Online eval config ARN (direct mode — bypasses project config) */
  arn?: string;
  /** AWS region (required with --arn when region cannot be parsed from ARN) */
  region?: string;
  json?: boolean;
}
