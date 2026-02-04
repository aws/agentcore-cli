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
const HIDDEN_FROM_TUI = ['update', 'package'] as const;

/**
 * Commands hidden from TUI when inside an existing project.
 * 'create' is hidden because users should use 'add' instead.
 */
const HIDDEN_WHEN_IN_PROJECT = ['create'] as const;

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
      subcommands: cmd.commands.map(sub => sub.name()),
      disabled: false,
    }));
}
