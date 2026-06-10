import {
  AgentEnvironment,
  AgentFramework,
  AgentLanguage,
  AgentProtocol,
  AgentSource,
  AttachMode,
  AuthType,
  AuthorizerType,
  BuildType,
  Count,
  CredentialType,
  DeployModeSchema,
  DevAction,
  EvaluatorLevel,
  EvaluatorType,
  FilterState,
  FilterType,
  GatewayTargetHost,
  GatewayTargetType,
  MemoryType,
  Mode,
  ModelProvider,
  NetworkMode,
  OutboundAuthType,
  PolicyAttrSourceType,
  PolicyEngineMode,
  PolicyValidationMode,
  RefType,
  ResourceType,
  UiMode,
  safeSchema,
} from './common-shapes.js';
import { z } from 'zod';

const CreateAttrs = safeSchema({
  agent_environment: AgentEnvironment,
  agent_language: AgentLanguage.optional(),
  agent_framework: AgentFramework.optional(),
  model_provider: ModelProvider,
  memory_type: MemoryType,
  agent_protocol: AgentProtocol.optional(),
  build_type: BuildType.optional(),
  agent_source: AgentSource.optional(),
  network_mode: NetworkMode,
  has_agent: z.boolean(),
});

const AddAgentAttrs = safeSchema({
  agent_language: AgentLanguage,
  agent_framework: AgentFramework,
  model_provider: ModelProvider,
  agent_source: AgentSource,
  build_type: BuildType,
  agent_protocol: AgentProtocol,
  network_mode: NetworkMode,
  authorizer_type: AuthorizerType,
  memory_type: MemoryType,
  efs_mount_count: Count,
  s3_mount_count: Count,
});

const AddMemoryAttrs = safeSchema({
  strategy_count: Count,
  strategy_semantic: z.boolean(),
  strategy_summarization: z.boolean(),
  strategy_user_preference: z.boolean(),
  strategy_episodic: z.boolean(),
  indexed_key_count: Count,
  has_indexed_keys: z.boolean(),
});

const AddCredentialAttrs = safeSchema({ credential_type: CredentialType });

const AddEvaluatorAttrs = safeSchema({ evaluator_type: EvaluatorType, evaluator_level: EvaluatorLevel });

const AddOnlineEvalAttrs = safeSchema({ evaluator_count: Count, enable_on_create: z.boolean() });

const AddGatewayAttrs = safeSchema({
  authorizer_type: AuthorizerType,
  has_policy_engine: z.boolean(),
  policy_engine_mode: PolicyEngineMode,
  semantic_search: z.boolean(),
  runtime_count: Count,
});

const AddGatewayTargetAttrs = safeSchema({
  gateway_target_type: GatewayTargetType,
  gateway_target_host: GatewayTargetHost,
  outbound_auth_type: OutboundAuthType,
});

const AddPolicyEngineAttrs = safeSchema({ attach_gateway_count: Count, attach_mode: AttachMode });

const AddPolicyAttrs = safeSchema({
  policy_attr_source_type: PolicyAttrSourceType,
  policy_validation_mode: PolicyValidationMode,
});

const DeployAttrs = safeSchema({
  runtime_count: Count,
  harness_count: Count,
  memory_count: Count,
  credential_count: Count,
  evaluator_count: Count,
  online_eval_count: Count,
  gateway_count: Count,
  gateway_target_count: Count,
  policy_engine_count: Count,
  policy_count: Count,
  deploy_mode: DeployModeSchema,
});

const DevAttrs = safeSchema({
  agent_environment: AgentEnvironment,
  dev_action: DevAction,
  ui_mode: UiMode,
  has_stream: z.boolean(),
  agent_protocol: AgentProtocol.optional(),
  invoke_count: Count,
});

const InvokeAttrs = safeSchema({
  agent_environment: AgentEnvironment,
  has_stream: z.boolean(),
  has_session_id: z.boolean(),
  auth_type: AuthType,
  agent_protocol: AgentProtocol.optional(),
});

const ExecAttrs = safeSchema({
  interactive: z.boolean(),
  has_runtime: z.boolean(),
  has_shell_id: z.boolean(),
  has_session_id: z.boolean(),
  is_one_shot: z.boolean(),
  auth_type: AuthType,
  is_reconnect: z.boolean(),
  exit_code: Count,
  reconnect_attempts: Count,
  was_kicked: z.boolean(),
});

const StatusAttrs = safeSchema({ filter_type: FilterType, filter_state: FilterState });

const LogsAttrs = safeSchema({ has_query: z.boolean(), has_level_filter: z.boolean() });

const LogsEvalsAttrs = safeSchema({ has_follow: z.boolean() });

const RunEvalAttrs = safeSchema({
  evaluator_count: Count,
  ref_type: RefType,
  has_assertions: z.boolean(),
  has_expected_trajectory: z.boolean(),
  has_expected_response: z.boolean(),
});

const FetchAccessAttrs = safeSchema({ resource_type: ResourceType });

const UpdateAttrs = safeSchema({ is_dry_run: z.boolean() });

const FeedbackAttrs = safeSchema({
  mode: Mode,
  has_screenshot: z.boolean(),
});

const PauseResumeOnlineEvalAttrs = safeSchema({ ref_type: RefType });

const NoAttrs = safeSchema({});

/*
  Mapping of commands to required attributes. 
  This is chosen over discriminated unions to avoid complexity in the root-level definition. 
*/
export const COMMAND_SCHEMAS = {
  create: CreateAttrs,
  'add.agent': AddAgentAttrs,
  'add.memory': AddMemoryAttrs,
  'add.dataset': NoAttrs,
  'add.credential': AddCredentialAttrs,
  'add.evaluator': AddEvaluatorAttrs,
  'add.online-eval': AddOnlineEvalAttrs,
  'add.gateway': AddGatewayAttrs,
  'add.gateway-target': AddGatewayTargetAttrs,
  'add.policy-engine': AddPolicyEngineAttrs,
  'add.policy': AddPolicyAttrs,
  'add.runtime-endpoint': NoAttrs,
  'add.payment-manager': NoAttrs,
  'add.payment-connector': NoAttrs,
  deploy: DeployAttrs,

  // dev / invoke / exec
  dev: DevAttrs,
  invoke: InvokeAttrs,
  exec: ExecAttrs,

  // status / logs
  status: StatusAttrs,
  logs: LogsAttrs,
  'logs.evals': LogsEvalsAttrs,
  'run.eval': RunEvalAttrs,
  'fetch.access': FetchAccessAttrs,
  feedback: FeedbackAttrs,
  update: UpdateAttrs,
  'pause.online-eval': PauseResumeOnlineEvalAttrs,
  'resume.online-eval': PauseResumeOnlineEvalAttrs,
  'traces.list': NoAttrs,
  'traces.get': NoAttrs,
  'evals.history': NoAttrs,
  import: NoAttrs,
  'import.runtime': NoAttrs,
  'import.memory': NoAttrs,
  'import.evaluator': NoAttrs,
  'import.online-eval': NoAttrs,
  'import.gateway': NoAttrs,
  package: NoAttrs,
  validate: NoAttrs,
  'help.modes': NoAttrs,
  help: NoAttrs,
  'remove.all': NoAttrs,
  'remove.agent': NoAttrs,
  'remove.harness': NoAttrs,
  'remove.memory': NoAttrs,
  'remove.dataset': NoAttrs,
  'remove.credential': NoAttrs,
  'remove.evaluator': NoAttrs,
  'remove.online-eval': NoAttrs,
  'remove.gateway': NoAttrs,
  'remove.gateway-target': NoAttrs,
  'remove.policy-engine': NoAttrs,
  'remove.policy': NoAttrs,
  'remove.runtime-endpoint': NoAttrs,
  'remove.config-bundle': NoAttrs,
  'remove.ab-test': NoAttrs,
  'dataset.download': NoAttrs,
  'dataset.publish-version': NoAttrs,
  'dataset.remove-version': NoAttrs,
  'remove.payment-manager': NoAttrs,
  'remove.payment-connector': NoAttrs,
  'telemetry.disable': NoAttrs,
  'telemetry.enable': NoAttrs,
  'telemetry.status': NoAttrs,
} as const satisfies Record<string, z.ZodObject<z.ZodRawShape>>;

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type Command = keyof typeof COMMAND_SCHEMAS;
export type CommandGroup = { [C in Command]: C extends `${infer G}.${string}` ? G : C }[Command];
export type CommandAttrs<C extends Command> = z.infer<(typeof COMMAND_SCHEMAS)[C]>;

export type SubCommand<G extends CommandGroup, S extends string> = Extract<Command, `${G}.${S}`>;

/** Derive command_group from command key (e.g. 'add.agent' → 'add') */
export function deriveCommandGroup(command: Command): CommandGroup {
  const dot = command.indexOf('.');
  return (dot === -1 ? command : command.slice(0, dot)) as CommandGroup;
}
