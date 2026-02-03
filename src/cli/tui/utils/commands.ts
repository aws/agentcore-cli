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
const HIDDEN_FROM_TUI = ['update', 'package', 'edit', 'plan'] as const;

export function getCommandsForUI(program: Command): CommandMeta[] {
  return program.commands
    .filter(cmd => !HIDDEN_FROM_TUI.includes(cmd.name() as (typeof HIDDEN_FROM_TUI)[number]))
    .map(cmd => ({
      id: cmd.name(),
      title: cmd.name(),
      description: cmd.description(),
      subcommands: cmd.commands.map(sub => sub.name()),
      disabled: false,
    }));
}
