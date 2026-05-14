import { ATTRIBUTES, safeSchema } from './common-shapes.js';
import { z } from 'zod';

/**
 * Metric registry — single source of truth for all metrics the CLI can emit.
 * Adding a new metric = adding one entry here.
 *
 * The schema defines attributes for compile-time type safety on emit().
 * For cli.command_run, required fields are always present; optional fields
 * are the union of all per-command attributes.
 */

const CommandRunSchema = safeSchema({
  command: ATTRIBUTES.Command,
  command_group: ATTRIBUTES.CommandGroup,
  exit_reason: ATTRIBUTES.ExitReason,
}).extend({
  // Error fields (present on failure)
  error_name: ATTRIBUTES.ErrorCategory.optional(),
  is_user_error: z.boolean().optional(),

  // Per-command attributes (optional — depends on which command ran)
  action: ATTRIBUTES.Action.optional(),
  agent_type: ATTRIBUTES.AgentType.optional(),
  attach_gateway_count: z.number().optional(),
  attach_mode: ATTRIBUTES.AttachMode.optional(),
  auth_type: ATTRIBUTES.AuthType.optional(),
  authorizer_type: ATTRIBUTES.AuthorizerType.optional(),
  build: ATTRIBUTES.Build.optional(),
  check_only: z.boolean().optional(),
  credential_count: z.number().optional(),
  credential_type: ATTRIBUTES.CredentialType.optional(),
  enable_on_create: z.boolean().optional(),
  evaluator_count: z.number().optional(),
  evaluator_type: ATTRIBUTES.EvaluatorType.optional(),
  filter_state: ATTRIBUTES.FilterState.optional(),
  filter_type: ATTRIBUTES.FilterType.optional(),
  framework: ATTRIBUTES.Framework.optional(),
  gateway_count: z.number().optional(),
  gateway_target_count: z.number().optional(),
  has_agent: z.boolean().optional(),
  has_assertions: z.boolean().optional(),
  has_expected_response: z.boolean().optional(),
  has_expected_trajectory: z.boolean().optional(),
  has_follow: z.boolean().optional(),
  has_level_filter: z.boolean().optional(),
  has_policy_engine: z.boolean().optional(),
  has_query: z.boolean().optional(),
  has_session_id: z.boolean().optional(),
  has_stream: z.boolean().optional(),
  host: ATTRIBUTES.GatewayTargetHost.optional(),
  invoke_count: z.number().optional(),
  language: ATTRIBUTES.Language.optional(),
  level: ATTRIBUTES.Level.optional(),
  memory: ATTRIBUTES.Memory.optional(),
  memory_count: z.number().optional(),
  deploy_mode: ATTRIBUTES.DeployMode.optional(),
  model_provider: ATTRIBUTES.ModelProvider.optional(),
  network_mode: ATTRIBUTES.NetworkMode.optional(),
  online_eval_count: z.number().optional(),
  outbound_auth: ATTRIBUTES.OutboundAuth.optional(),
  policy_count: z.number().optional(),
  policy_engine_count: z.number().optional(),
  policy_engine_mode: ATTRIBUTES.PolicyEngineMode.optional(),
  protocol: ATTRIBUTES.Protocol.optional(),
  ref_type: ATTRIBUTES.RefType.optional(),
  resource_type: ATTRIBUTES.ResourceType.optional(),
  runtime_count: z.number().optional(),
  semantic_search: z.boolean().optional(),
  source_type: ATTRIBUTES.SourceType.optional(),
  strategy_count: z.number().optional(),
  strategy_episodic: z.boolean().optional(),
  strategy_semantic: z.boolean().optional(),
  strategy_summarization: z.boolean().optional(),
  strategy_user_preference: z.boolean().optional(),
  target_type: ATTRIBUTES.GatewayTargetType.optional(),
  ui_mode: ATTRIBUTES.UiMode.optional(),
  validation_mode: ATTRIBUTES.ValidationMode.optional(),
});

export const METRICS = {
  'cli.command_run': {
    schema: CommandRunSchema,
  },
} as const;

export type MetricName = keyof typeof METRICS;
export type MetricAttrs<M extends MetricName> = z.infer<(typeof METRICS)[M]['schema']>;
