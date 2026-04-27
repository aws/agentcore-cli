import { z } from 'zod';

// Type-safe schema builder: rejects z.string() at compile time.
// Only z.enum(), z.boolean(), z.number(), and z.literal() are allowed as field types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SafeField = z.ZodEnum<any> | z.ZodBoolean | z.ZodNumber | z.ZodLiteral<any>;
export function safeSchema<T extends Record<string, SafeField>>(shape: T) {
  return z.object(shape);
}

// Primitive types
export const Count = z.number().int().nonnegative();

// Shared enums — alphabetical, one per attribute name from the metric shape spec
export const Action = z.enum(['server', 'invoke']);
export const AgentType = z.enum(['create', 'byo', 'import']);
export const AttachMode = z.enum(['log_only', 'enforce']);
export const AuthType = z.enum(['sigv4', 'bearer_token']);
export const AuthorizerType = z.enum(['aws_iam', 'custom_jwt', 'none']);
export const Build = z.enum(['codezip', 'container']);
export const CredentialType = z.enum(['api-key', 'oauth']);
export const EvaluatorType = z.enum(['llm-as-a-judge', 'code-based']);
export const ExitReason = z.enum(['success', 'failure', 'cancel']);
export const FilterState = z.enum(['deployed', 'local-only', 'pending-removal', 'none']);
export const FilterType = z.enum([
  'agent',
  'memory',
  'credential',
  'gateway',
  'evaluator',
  'online-eval',
  'policy-engine',
  'policy',
  'none',
]);
export const Framework = z.enum(['strands', 'langchain_langgraph', 'googleadk', 'openaiagents']);
export const GatewayTargetHost = z.enum(['lambda', 'agentcoreruntime']);
export const GatewayTargetType = z.enum([
  'mcp-server',
  'api-gateway',
  'open-api-schema',
  'smithy-model',
  'lambda-function-arn',
]);
export const Language = z.enum(['python', 'typescript', 'other']);
export const Level = z.enum(['session', 'trace', 'tool_call']);
export const Memory = z.enum(['none', 'shortterm', 'longandshortterm']);
export const Mode = z.enum(['cli', 'tui']);
export const ModelProvider = z.enum(['bedrock', 'anthropic', 'openai', 'gemini']);
export const NetworkMode = z.enum(['public', 'vpc']);
export const OutboundAuth = z.enum(['oauth', 'api-key', 'none']);
export const PolicyEngineMode = z.enum(['log_only', 'enforce']);
export const Protocol = z.enum(['http', 'mcp', 'a2a']);
export const RefType = z.enum(['arn', 'name']);
export const ResourceType = z.enum(['gateway', 'agent']);
export const SourceType = z.enum(['file', 'statement', 'generate']);
export const ValidationMode = z.enum(['fail_on_any_findings', 'ignore_all_findings']);

export const ErrorCategory = z.enum([
  'ConfigError',
  'CredentialsError',
  'PackagingError',
  'ProjectError',
  'ServiceError',
  'ConnectionError',
  'UnknownError',
]);

// Common result shapes — reusable across metrics
export const SuccessResult = z.object({ exit_reason: z.literal('success') });
export const CancelResult = z.object({ exit_reason: z.literal('cancel') });
export const FailureResult = z.object({
  exit_reason: z.literal('failure'),
  error_name: ErrorCategory,
  is_user_error: z.boolean(),
});
export const CommandResultSchema = z.discriminatedUnion('exit_reason', [SuccessResult, CancelResult, FailureResult]);
export type CommandResult = z.infer<typeof CommandResultSchema>;
