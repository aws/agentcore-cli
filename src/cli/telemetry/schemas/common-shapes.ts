import { z } from 'zod';

// Type-safe schema builder: rejects z.string() at compile time.
// Only z.enum(), z.boolean(), z.number(), and z.literal() are allowed as field types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BaseSafeField = z.ZodEnum<any> | z.ZodBoolean | z.ZodNumber | z.ZodLiteral<any>;
type SafeField = BaseSafeField | z.ZodOptional<BaseSafeField>;
export function safeSchema<T extends Record<string, SafeField>>(shape: T) {
  return z.object(shape);
}

/**
 * Lowercase a CLI value and parse it through a Zod enum, returning the narrowed type.
 * The `as` cast on the failure branch is intentional: invalid values pass through to
 * recordCommandRun, where COMMAND_SCHEMAS[command].parse(attrs) validates the full
 * attr object with resilient parsing.
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

export const Count = z.number().int().nonnegative();

export const DevAction = z.enum(['server', 'invoke', 'exec']);
export const UiMode = z.enum(['browser', 'terminal']);
export const AgentSource = z.enum(['create', 'byo', 'import']);
export const AttachMode = z.enum(['log_only', 'enforce']);
export const AuthType = z.enum(['sigv4', 'bearer_token']);
export const AuthorizerType = z.enum(['aws_iam', 'custom_jwt', 'none']);
export const BuildType = z.enum(['codezip', 'container']);
export const CredentialType = z.enum(['api-key', 'oauth']);
export const EvaluatorType = z.enum(['llm-as-a-judge', 'code-based']);
export const ExitReason = z.enum(['success', 'failure']);
export const FilterState = z.enum(['deployed', 'local-only', 'pending-removal', 'none']);
export const FilterType = z.enum([
  'agent',
  'runtime-endpoint',
  'memory',
  'credential',
  'gateway',
  'evaluator',
  'online-eval',
  'policy-engine',
  'policy',
  'config-bundle',
  'ab-test',
  'dataset',
  'harness',
  'none',
]);
export const AgentEnvironment = z.enum(['harness', 'runtime']);
export const AgentFramework = z.enum(['strands', 'langchain_langgraph', 'googleadk', 'openaiagents']);
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
export const AgentLanguage = z.enum(['python', 'typescript', 'other']);
export const EvaluatorLevel = z.enum(['session', 'trace', 'tool_call']);
export const MemoryType = z.enum(['none', 'shortterm', 'longandshortterm']);
export const Mode = z.enum(['cli', 'tui']);
export const ModelProvider = z.enum(['bedrock', 'anthropic', 'openai', 'gemini']);
export const NetworkMode = z.enum(['public', 'vpc']);
export const OutboundAuthType = z.enum(['oauth', 'api-key', 'none']);
export const PolicyEngineMode = z.enum(['log_only', 'enforce']);
export const AgentProtocol = z.enum(['http', 'mcp', 'a2a', 'agui']);
export const RefType = z.enum(['arn', 'name']);
export const ResourceType = z.enum(['gateway', 'agent']);
export const PolicyAttrSourceType = z.enum(['file', 'statement', 'generate']);
export const PolicyValidationMode = z.enum(['fail_on_any_findings', 'ignore_all_findings']);

export const ErrorName = z.enum([
  'AccessDeniedError',
  'AgentAlreadyExistsError',
  'ArtifactSizeError',
  'AwsCredentialsError',
  'ConfigNotFoundError',
  'ConfigParseError',
  'ConfigReadError',
  'ConfigValidationError',
  'ConfigWriteError',
  'ConflictError',
  'ConnectionError',
  'DependencyCheckError',
  'GitInitError',
  'MissingDependencyError',
  'MissingProjectFileError',
  'NoProjectError',
  'PackagingError',
  'PollExhaustedError',
  'PollTimeoutError',
  'ResourceNotFoundError',
  'ServerError',
  'ShellKickedError',
  'TimeoutError',
  'UnsupportedLanguageError',
  'UserCancellationError',
  'ValidationError',
  'UnknownError',
]);

export const ErrorSource = z.enum(['user', 'client', 'service', 'unknown']);

// Common result shapes — reusable across metrics
export const SuccessResult = z.object({ exit_reason: z.literal('success') });
export const FailureResult = z.object({
  exit_reason: z.literal('failure'),
  error_name: ErrorName,
  error_source: ErrorSource,
});
export const CommandResultSchema = z.discriminatedUnion('exit_reason', [SuccessResult, FailureResult]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const DeployModeSchema = z.enum(['deploy', 'dry-run', 'diff']);
export type DeployMode = z.infer<typeof DeployModeSchema>;

/*
  All attributes the CLI may attach to a metric.
  Keys are the field names as they appear in emitted metrics.
*/
export const ATTRIBUTES = {
  agent_environment: AgentEnvironment,
  dev_action: DevAction,
  agent_source: AgentSource,
  attach_gateway_count: Count,
  attach_mode: AttachMode,
  auth_type: AuthType,
  authorizer_type: AuthorizerType,
  build_type: BuildType,
  is_dry_run: z.boolean(),
  credential_count: Count,
  credential_type: CredentialType,
  deploy_mode: DeployModeSchema,
  enable_on_create: z.boolean(),
  error_name: ErrorName,
  evaluator_count: Count,
  evaluator_type: EvaluatorType,
  exit_reason: ExitReason,
  filter_state: FilterState,
  filter_type: FilterType,
  agent_framework: AgentFramework,
  gateway_count: Count,
  gateway_target_count: Count,
  has_agent: z.boolean(),
  has_assertions: z.boolean(),
  has_expected_response: z.boolean(),
  has_expected_trajectory: z.boolean(),
  has_follow: z.boolean(),
  has_level_filter: z.boolean(),
  has_policy_engine: z.boolean(),
  has_query: z.boolean(),
  has_session_id: z.boolean(),
  has_stream: z.boolean(),
  gateway_target_host: GatewayTargetHost,
  invoke_count: Count,
  error_source: ErrorSource,
  agent_language: AgentLanguage,
  evaluator_level: EvaluatorLevel,
  memory_type: MemoryType,
  memory_count: Count,
  model_provider: ModelProvider,
  network_mode: NetworkMode,
  online_eval_count: Count,
  outbound_auth_type: OutboundAuthType,
  policy_count: Count,
  policy_engine_count: Count,
  policy_engine_mode: PolicyEngineMode,
  agent_protocol: AgentProtocol,
  ref_type: RefType,
  resource_type: ResourceType,
  runtime_count: Count,
  semantic_search: z.boolean(),
  policy_attr_source_type: PolicyAttrSourceType,
  strategy_count: Count,
  strategy_episodic: z.boolean(),
  strategy_semantic: z.boolean(),
  strategy_summarization: z.boolean(),
  strategy_user_preference: z.boolean(),
  gateway_target_type: GatewayTargetType,
  ui_mode: UiMode,
  policy_validation_mode: PolicyValidationMode,
} as const;
