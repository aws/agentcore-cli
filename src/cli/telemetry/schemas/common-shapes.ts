import { z } from 'zod';

// Type-safe schema builder: rejects z.string() at compile time.
// Only z.enum(), z.boolean(), z.number(), and z.literal() are allowed as field types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SafeField = z.ZodEnum<any> | z.ZodBoolean | z.ZodNumber | z.ZodLiteral<any>;
export function safeSchema<T extends Record<string, SafeField>>(shape: T) {
  return z.object(shape);
}

/**
 * Validate each field in a schema individually, defaulting to 'unknown' on failure.
 * This ensures a single invalid attribute never blocks the entire metric from being published.
 * Keys in attrs not present in the schema are omitted from the result.
 */
export function resilientParse(
  schema: z.ZodObject<z.ZodRawShape>,
  attrs: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) {
    const field = schema.shape[key] as z.ZodType;
    const parsed = field.safeParse(attrs[key]);
    result[key] = parsed.success ? parsed.data : 'unknown';
  }
  return result;
}

/**
 * Lowercase a CLI value and parse it through a Zod enum, returning the narrowed type.
 * The `as` cast on the failure branch is intentional: invalid values pass through to
 * recordCommandRun, where COMMAND_SCHEMAS[command].parse(attrs) validates the full
 * attr object in a try/catch — silently dropping the metric if any field is invalid.
 * This ensures telemetry never crashes the CLI while keeping the happy-path type-safe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function standardize<T extends z.ZodEnum<any>>(schema: T, value: string | undefined): z.infer<T> {
  const lower = (value ?? '').toLowerCase();
  const result = schema.safeParse(lower);
  // If the value doesn't match the enum, return the lowercased value anyway —
  // recordCommandRun's try/catch will silently drop the invalid metric.
  return (result.success ? result.data : lower) as z.infer<T>;
}

// Primitive types
export const Count = z.number().int().nonnegative();

// Shared enums — alphabetical, one per attribute name from the metric shape spec
export const Action = z.enum(['server', 'invoke', 'exec']);
export const UiMode = z.enum(['browser', 'terminal']);
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
  'unknown',
]);

/** Map camelCase CLI target type to kebab-case telemetry enum value. */
export const GATEWAY_TARGET_TYPE_MAP: Record<string, z.infer<typeof GatewayTargetType>> = {
  apiGateway: 'api-gateway',
  openApiSchema: 'open-api-schema',
  smithyModel: 'smithy-model',
  lambdaFunctionArn: 'lambda-function-arn',
  mcpServer: 'mcp-server',
};
export const Language = z.enum(['python', 'typescript', 'other']);
export const Level = z.enum(['session', 'trace', 'tool_call']);
export const Memory = z.enum(['none', 'shortterm', 'longandshortterm']);
export const Mode = z.enum(['cli', 'tui']);
export const ModelProvider = z.enum(['bedrock', 'anthropic', 'openai', 'gemini']);
export const NetworkMode = z.enum(['public', 'vpc']);
export const OutboundAuth = z.enum(['oauth', 'api-key', 'none']);
export const PolicyEngineMode = z.enum(['log_only', 'enforce']);
export const Protocol = z.enum(['http', 'mcp', 'a2a', 'agui']);
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
