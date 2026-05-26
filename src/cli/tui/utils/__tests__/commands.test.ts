import { getCommandsForUI } from '../commands.js';
import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';

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
    makeCmd('add', 'Add a resource', ['agent', 'memory', 'gateway', 'gateway-target']),
    makeCmd('deploy', 'Deploy to AWS'),
    makeCmd('status', 'Check status'),
    makeCmd('help', 'Show help'),
    makeCmd('update', 'Check for updates'),
    makeCmd('package', 'Package artifacts'),
    makeCmd('logs', 'Stream logs'),
    makeCmd('traces', 'View traces'),
    makeCmd('pause', 'Pause online eval'),
    makeCmd('resume', 'Resume online eval'),
  ]);

  it('filters out help command (meta)', () => {
    const cmds = getCommandsForUI(program);
    const names = cmds.map(c => c.id);
    expect(names).not.toContain('help');
  });

  it('includes update and package as interactive commands', () => {
    const cmds = getCommandsForUI(program);
    const update = cmds.find(c => c.id === 'update');
    const pkg = cmds.find(c => c.id === 'package');
    expect(update).toBeDefined();
    expect(update!.cliOnly).toBe(false);
    expect(pkg).toBeDefined();
    expect(pkg!.cliOnly).toBe(false);
  });

  it('marks traces, pause, resume as cliOnly', () => {
    const cmds = getCommandsForUI(program);
    for (const name of ['traces', 'pause', 'resume']) {
      const cmd = cmds.find(c => c.id === name);
      expect(cmd, `${name} should be in results`).toBeDefined();
      expect(cmd!.cliOnly, `${name} should be cliOnly`).toBe(true);
    }
  });

  it('marks interactive commands as not cliOnly', () => {
    const cmds = getCommandsForUI(program);
    for (const name of ['create', 'add', 'deploy', 'status']) {
      const cmd = cmds.find(c => c.id === name);
      expect(cmd, `${name} should be in results`).toBeDefined();
      expect(cmd!.cliOnly, `${name} should not be cliOnly`).toBe(false);
    }
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

  it('filters hidden subcommands (gateway, gateway-target)', () => {
    const cmds = getCommandsForUI(program);
    const addCmd = cmds.find(c => c.id === 'add');
    expect(addCmd).toBeDefined();
    expect(addCmd!.subcommands).toContain('agent');
    expect(addCmd!.subcommands).toContain('memory');
    expect(addCmd!.subcommands).not.toContain('gateway');
    expect(addCmd!.subcommands).not.toContain('gateway-target');
  });

  it('returns command metadata shape with cliOnly field', () => {
    const cmds = getCommandsForUI(program);
    const deploy = cmds.find(c => c.id === 'deploy');
    expect(deploy).toEqual({
      id: 'deploy',
      title: 'deploy',
      description: 'Deploy to AWS',
      subcommands: [],
      disabled: false,
      cliOnly: false,
    });
  });
});
