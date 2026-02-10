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
  add: 'Add resources to your project',
  create: 'Create a new AgentCore project',
  deploy: 'Deploy Bedrock AgentCore agent.',
  dev: 'Launch local development server.',
  edit: 'Open schema editor.',
  invoke: 'Invoke Bedrock AgentCore endpoint.',
  package: 'Package Bedrock AgentCore runtime artifacts.',
  remove: 'Remove AgentCore resources and project',
  status: 'Retrieve details of deployed AgentCore resources.',
  update: 'Check for and install CLI updates',
  validate: 'Validate agentcore/ config files.',
} as const;
