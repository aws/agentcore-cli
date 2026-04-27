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
  COMMANDS: 'Type to filter, ↑↓ navigate, Enter select, Esc exit',
  COMMANDS_SHOW_ALL: 'Type to filter · ↑↓ Enter select · / show all · Esc exit',
  COMMANDS_HIDE_CLI: 'Type to filter · ↑↓ Enter select · / hide cli · Esc exit',
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
  add: 'Add resources to project config.',
  create: 'Create a new AgentCore project',
  deploy: 'Deploy project infrastructure to AWS via CDK.',
  dev: 'Launch local dev server, or invoke an agent locally.',
  invoke: 'Invoke a deployed agent endpoint.',
  logs: 'Stream or search agent runtime logs.',
  package: 'Package agent artifacts without deploying.',
  remove: 'Remove resources from project config.',
  status: 'Show deployed resource details and status.',
  traces: 'View and download agent traces.',
  evals: 'View past eval run results.',
  fetch: 'Fetch access info for deployed resources.',
  pause: 'Pause an online eval config. Supports --arn for configs outside the project.',
  resume: 'Resume a paused online eval config. Supports --arn for configs outside the project.',
  run: 'Run on-demand evaluation.',
  import: 'Import a runtime, memory, or starter toolkit into this project. [experimental]',
  telemetry: 'Manage anonymous usage analytics preferences.',
  update: 'Check for and install CLI updates',
  validate: 'Validate agentcore/ config files.',
} as const;

/**
 * CLI-only command examples and usage information.
 * These commands must run in the terminal, not in the TUI.
 */
export const CLI_ONLY_EXAMPLES: Record<string, { description: string; examples: string[] }> = {
  logs: {
    description: 'Stream or search agent runtime logs. This command runs in the terminal.',
    examples: [
      'agentcore logs',
      'agentcore logs --since 30m --level error',
      'agentcore logs --agent MyAgent --query "timeout"',
      'agentcore logs evals --since 1h',
    ],
  },
  traces: {
    description: 'View and download agent traces. This command runs in the terminal.',
    examples: [
      'agentcore traces list',
      'agentcore traces list --since 1h --limit 10',
      'agentcore traces get <traceId>',
    ],
  },
  pause: {
    description: 'Pause a deployed online eval config. This command runs in the terminal.',
    examples: ['agentcore pause online-eval <name>', 'agentcore pause online-eval --arn <arn>'],
  },
  resume: {
    description: 'Resume a paused online eval config. This command runs in the terminal.',
    examples: ['agentcore resume online-eval <name>', 'agentcore resume online-eval --arn <arn>'],
  },
};
