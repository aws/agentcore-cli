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
 * CLI-only command examples and usage information.
 * These commands must run in the terminal, not in the TUI.
 */
export const CLI_ONLY_EXAMPLES: Record<string, { description: string; examples: string[] }> = {
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
  'run eval': {
    description: 'Run on-demand evaluation of runtime traces against one or more evaluators.',
    examples: [
      'agentcore run eval -r MyAgent -e Builtin.Correctness',
      'agentcore run eval -r MyAgent -e Builtin.Faithfulness --lookback 14',
      'agentcore run eval -r MyAgent -e Builtin.Correctness -A "Must mention pricing" --expected-response "The price is $10"',
      'agentcore run eval --runtime-arn <arn> --evaluator-arn <arn> --region us-east-1',
    ],
  },
  'run batch-evaluation': {
    description: 'Run evaluators in batch across all agent sessions found in CloudWatch.',
    examples: [
      'agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness',
      'agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness Builtin.Faithfulness --json',
      'agentcore run batch-evaluation -r MyAgent -e Builtin.Completeness -n "weekly-check"',
    ],
  },
  'run recommendation': {
    description: 'Optimize system prompts or tool descriptions using agent traces.',
    examples: [
      'agentcore run recommendation -t system-prompt -r MyAgent -e Builtin.Correctness --inline "You are a helpful assistant"',
      'agentcore run recommendation -t system-prompt -r MyAgent -e Builtin.Correctness --prompt-file ./prompt.txt',
      'agentcore run recommendation -t tool-description -r MyAgent --tools "search:Searches the web,calc:Does math"',
      'agentcore run recommendation -t system-prompt -r MyAgent -e Builtin.Correctness --bundle-name MyBundle',
    ],
  },
  stop: {
    description: 'Stop a running batch evaluation or A/B test.',
    examples: [
      'agentcore stop batch-evaluation -i <batch-eval-id>',
      'agentcore stop batch-evaluation -i <batch-eval-id> --json',
      'agentcore stop ab-test <name>',
    ],
  },
  archive: {
    description: 'Archive (delete) a batch evaluation or recommendation on the service and clear local history.',
    examples: [
      'agentcore archive batch-evaluation -i <batch-eval-id>',
      'agentcore archive batch-evaluation -i <batch-eval-id> --region us-west-2',
      'agentcore archive batch-evaluation -i <batch-eval-id> --json',
      'agentcore archive recommendation -i <recommendation-id>',
      'agentcore archive recommendation -i <recommendation-id> --region us-west-2',
      'agentcore archive recommendation -i <recommendation-id> --json',
    ],
  },
};
