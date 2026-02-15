import { getCommandsForUI } from '../commands.js';
import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';

/** Minimal mock matching Commander's Command interface shape */
function makeCmd(name: string, desc: string, subs: string[] = []) {
  return {
    name: () => name,
    description: () => desc,
    commands: subs.map(s => ({
      name: () => s,
      description: () => '',
      commands: [],
    })),
  } as unknown as Command;
}

function makeProgram(cmds: Command[]) {
  return { commands: cmds } as unknown as Command;
}

describe('getCommandsForUI', () => {
  const program = makeProgram([
    makeCmd('create', 'Create a new project'),
    makeCmd('add', 'Add a resource', ['agent', 'memory', 'gateway', 'mcp-tool']),
    makeCmd('deploy', 'Deploy to AWS'),
    makeCmd('status', 'Check status'),
    makeCmd('help', 'Show help'),
    makeCmd('update', 'Check for updates'),
    makeCmd('package', 'Package artifacts'),
  ]);

  it('filters out help, update, and package commands', () => {
    const cmds = getCommandsForUI(program);
    const names = cmds.map(c => c.id);
    expect(names).not.toContain('help');
    expect(names).not.toContain('update');
    expect(names).not.toContain('package');
  });

  it('includes visible commands', () => {
    const cmds = getCommandsForUI(program);
    const names = cmds.map(c => c.id);
    expect(names).toContain('create');
    expect(names).toContain('add');
    expect(names).toContain('deploy');
    expect(names).toContain('status');
  });

  it('hides create when inProject is true', () => {
    const cmds = getCommandsForUI(program, { inProject: true });
    const names = cmds.map(c => c.id);
    expect(names).not.toContain('create');
    expect(names).toContain('add');
  });

  it('shows create when inProject is false', () => {
    const cmds = getCommandsForUI(program, { inProject: false });
    const names = cmds.map(c => c.id);
    expect(names).toContain('create');
  });

  it('filters hidden subcommands (gateway, mcp-tool)', () => {
    const cmds = getCommandsForUI(program);
    const addCmd = cmds.find(c => c.id === 'add');
    expect(addCmd).toBeDefined();
    expect(addCmd!.subcommands).toContain('agent');
    expect(addCmd!.subcommands).toContain('memory');
    expect(addCmd!.subcommands).not.toContain('gateway');
    expect(addCmd!.subcommands).not.toContain('mcp-tool');
  });

  it('returns command metadata shape', () => {
    const cmds = getCommandsForUI(program);
    const deploy = cmds.find(c => c.id === 'deploy');
    expect(deploy).toEqual({
      id: 'deploy',
      title: 'deploy',
      description: 'Deploy to AWS',
      subcommands: [],
      disabled: false,
    });
  });
});
