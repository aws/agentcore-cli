/**
 * User-facing copy and text displayed in the TUI.
 * Centralized here for consistency and easy updates.
 */

/**
 * Hint text displayed on main screens.
 * Uses · as separator for compact, readable hints.
 */
export const HINTS = {
  HOME: 'Type to search, Tab commands, Esc quit',
  COMMANDS: 'Type to filter, ↑↓ navigate, Enter select, Esc back',
} as const;

/**
 * Quick start command descriptions shown on home screen.
 */
export const QUICK_START = {
  create: 'Create a new AgentCore project',
  add: 'Add agents and environment resources',
  deploy: 'Deploy project to AWS',
  tip: 'Coding agents can implement project and config changes',
} as const;

/**
 * Command descriptions used in CLI help and TUI.
 */
export const COMMAND_DESCRIPTIONS = {
  /** Main program description */
  program: 'Build and deploy Agentic AI applications on AgentCore',
  /** Command descriptions */
  add: 'Add resources (agent, evaluator, online-eval, memory, identity, target)',
  create: 'Create a new AgentCore project',
  deploy: 'Deploy project infrastructure to AWS via CDK.',
  dev: 'Launch local development server with hot-reload.',
  edit: 'Open schema editor.',
  invoke: 'Invoke a deployed agent endpoint.',
  logs: 'Stream or search agent runtime logs.',
  package: 'Package agent artifacts without deploying.',
  remove: 'Remove resources from project config.',
  status: 'Show deployed resource details and status.',
  traces: 'View and download agent traces.',
  evals: 'View past eval run results. Also supports --agent-arn.',
  pause: 'Pause an online eval config. Supports --arn for configs outside the project.',
  resume: 'Resume a paused online eval config. Supports --arn for configs outside the project.',
  run: 'Run on-demand evaluation. Supports --agent-arn for agents outside the project.',
  update: 'Check for and install CLI updates',
  validate: 'Validate agentcore/ config files.',
} as const;
