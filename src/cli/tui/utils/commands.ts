import type { Command } from '@commander-js/extra-typings';

export interface CommandMeta {
  id: string;
  title: string;
  description: string;
  subcommands: string[];
  disabled?: boolean;
}

/**
 * Commands hidden from TUI help but still available via CLI.
 */
const HIDDEN_FROM_TUI = ['help', 'update', 'package'] as const;

/**
 * Commands hidden from TUI when inside an existing project.
 * 'create' is hidden because users should use 'add' instead.
 */
const HIDDEN_WHEN_IN_PROJECT = ['create'] as const;

/**
 * Subcommands hidden from TUI suggestions.
 * These are registered with { hidden: true } in commander but we track them
 * here since commander doesn't expose a public API to check hidden status.
 */
const HIDDEN_SUBCOMMANDS = ['gateway', 'mcp-tool'] as const;

interface GetCommandsOptions {
  /** Whether user is currently inside an AgentCore project */
  inProject?: boolean;
}

export function getCommandsForUI(program: Command, options: GetCommandsOptions = {}): CommandMeta[] {
  const { inProject = false } = options;

  return program.commands
    .filter(cmd => !HIDDEN_FROM_TUI.includes(cmd.name() as (typeof HIDDEN_FROM_TUI)[number]))
    .filter(
      cmd => !inProject || !HIDDEN_WHEN_IN_PROJECT.includes(cmd.name() as (typeof HIDDEN_WHEN_IN_PROJECT)[number])
    )
    .map(cmd => ({
      id: cmd.name(),
      title: cmd.name(),
      description: cmd.description(),
      subcommands: cmd.commands
        .filter(sub => !HIDDEN_SUBCOMMANDS.includes(sub.name() as (typeof HIDDEN_SUBCOMMANDS)[number]))
        .map(sub => sub.name()),
      disabled: false,
    }));
}
