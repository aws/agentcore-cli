import {
  Action,
  AgentType,
  AttachMode,
  AuthType,
  AuthorizerType,
  Build,
  Count,
  CredentialType,
  EvaluatorType,
  FilterState,
  FilterType,
  Framework,
  GatewayTargetHost,
  GatewayTargetType,
  Language,
  Level,
  Memory,
  ModelProvider,
  NetworkMode,
  OutboundAuth,
  PolicyEngineMode,
  Protocol,
  RefType,
  ResourceType,
  SourceType,
  ValidationMode,
  safeSchema,
} from './common-shapes.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-command attribute schemas
// All schemas use safeSchema() which rejects z.string() at compile time.
// ---------------------------------------------------------------------------

const CreateAttrs = safeSchema({
  language: Language,
  framework: Framework,
  model_provider: ModelProvider,
  memory: Memory,
  protocol: Protocol,
  build: Build,
  agent_type: AgentType,
  network_mode: NetworkMode,
  has_agent: z.boolean(),
});

const AddAgentAttrs = safeSchema({
  language: Language,
  framework: Framework,
  model_provider: ModelProvider,
  agent_type: AgentType,
  build: Build,
  protocol: Protocol,
  network_mode: NetworkMode,
  authorizer_type: AuthorizerType,
  memory: Memory,
});

const AddMemoryAttrs = safeSchema({
  strategy_count: Count,
  strategy_semantic: z.boolean(),
  strategy_summarization: z.boolean(),
  strategy_user_preference: z.boolean(),
  strategy_episodic: z.boolean(),
});

const AddCredentialAttrs = safeSchema({ credential_type: CredentialType });

const AddEvaluatorAttrs = safeSchema({ evaluator_type: EvaluatorType, level: Level });

const AddOnlineEvalAttrs = safeSchema({ evaluator_count: Count, enable_on_create: z.boolean() });

const AddGatewayAttrs = safeSchema({
  authorizer_type: AuthorizerType,
  has_policy_engine: z.boolean(),
  policy_engine_mode: PolicyEngineMode,
  semantic_search: z.boolean(),
  runtime_count: Count,
});

const AddGatewayTargetAttrs = safeSchema({
  target_type: GatewayTargetType,
  host: GatewayTargetHost,
  outbound_auth: OutboundAuth,
});

const AddPolicyEngineAttrs = safeSchema({ attach_gateway_count: Count, attach_mode: AttachMode });

const AddPolicyAttrs = safeSchema({ source_type: SourceType, validation_mode: ValidationMode });

const DeployAttrs = safeSchema({
  runtime_count: Count,
  memory_count: Count,
  credential_count: Count,
  evaluator_count: Count,
  online_eval_count: Count,
  gateway_count: Count,
  gateway_target_count: Count,
  policy_engine_count: Count,
  policy_count: Count,
  mode: z.enum(['deploy', 'dry-run', 'diff']),
});

const DevAttrs = safeSchema({
  action: Action,
  has_stream: z.boolean(),
  protocol: Protocol,
  invoke_count: Count,
});

const InvokeAttrs = safeSchema({
  has_stream: z.boolean(),
  has_session_id: z.boolean(),
  auth_type: AuthType,
  protocol: Protocol,
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

const UpdateAttrs = safeSchema({ check_only: z.boolean() });

const PauseResumeOnlineEvalAttrs = safeSchema({ ref_type: RefType });

const NoAttrs = safeSchema({});

// ---------------------------------------------------------------------------
// Command schema registry — single source of truth
// ---------------------------------------------------------------------------

export const COMMAND_SCHEMAS = {
  // create
  create: CreateAttrs,

  // add
  'add.agent': AddAgentAttrs,
  'add.memory': AddMemoryAttrs,
  'add.credential': AddCredentialAttrs,
  'add.evaluator': AddEvaluatorAttrs,
  'add.online-eval': AddOnlineEvalAttrs,
  'add.gateway': AddGatewayAttrs,
  'add.gateway-target': AddGatewayTargetAttrs,
  'add.policy-engine': AddPolicyEngineAttrs,
  'add.policy': AddPolicyAttrs,
  'add.runtime-endpoint': NoAttrs,

  // deploy
  deploy: DeployAttrs,

  // dev / invoke
  dev: DevAttrs,
  invoke: InvokeAttrs,

  // status / logs
  status: StatusAttrs,
  logs: LogsAttrs,
  'logs.evals': LogsEvalsAttrs,

  // run
  'run.eval': RunEvalAttrs,

  // fetch
  'fetch.access': FetchAccessAttrs,

  // update
  update: UpdateAttrs,

  // pause / resume
  'pause.online-eval': PauseResumeOnlineEvalAttrs,
  'resume.online-eval': PauseResumeOnlineEvalAttrs,

  // no command-specific attributes
  'traces.list': NoAttrs,
  'traces.get': NoAttrs,
  'evals.history': NoAttrs,
  import: NoAttrs,
  'import.runtime': NoAttrs,
  'import.memory': NoAttrs,
  package: NoAttrs,
  validate: NoAttrs,
  'help.modes': NoAttrs,
  help: NoAttrs,
  'remove.all': NoAttrs,
  'remove.agent': NoAttrs,
  'remove.memory': NoAttrs,
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
  'telemetry.disable': NoAttrs,
  'telemetry.enable': NoAttrs,
  'telemetry.status': NoAttrs,
} as const satisfies Record<string, z.ZodObject<z.ZodRawShape>>;

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type Command = keyof typeof COMMAND_SCHEMAS;
export type CommandAttrs<C extends Command> = z.infer<(typeof COMMAND_SCHEMAS)[C]>;

/** Extract the command group prefix from a dotted command key (e.g. 'add' from 'add.agent'). */
type CommandGroup = {
  [C in Command]: C extends `${infer G}.${string}` ? G : C;
}[Command];

/**
 * Type-safe lookup of a subcommand under a command group.
 * Produces a compile-time error if `${G}.${S}` is not a registered command.
 *
 * @example
 * SubCommand<'remove', 'agent'>  // → 'remove.agent'
 * SubCommand<'add', 'memory'>    // → 'add.memory'
 * SubCommand<'remove', 'bogus'>  // → never (compile error at call site)
 */
export type SubCommand<G extends CommandGroup, S extends string> = Extract<Command, `${G}.${S}`>;

/** Derive command_group from command key (e.g. 'add.agent' → 'add') */
export function deriveCommandGroup(command: Command): string {
  const dot = command.indexOf('.');
  return dot === -1 ? command : command.slice(0, dot);
}
