import { getShellArgs, getShellCommand, getVenvExecutable, normalizeCommand } from '../platform.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('getVenvExecutable', () => {
  it('returns bin path on unix', () => {
    const result = getVenvExecutable('.venv', 'python');
    expect(result).toContain('python');
    expect(result).toMatch(/\.venv/);
  });

  it('includes executable name in path', () => {
    const result = getVenvExecutable('/path/to/.venv', 'uvicorn');
    expect(result).toContain('uvicorn');
  });
});

describe('getShellCommand', () => {
  it('returns a string', () => {
    const result = getShellCommand();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('getShellArgs', () => {
  it('wraps command with shell flag', () => {
    const args = getShellArgs('echo hello');
    expect(args).toHaveLength(2);
    expect(args[1]).toBe('echo hello');
  });
});

describe('normalizeCommand', () => {
  it('returns command unchanged on non-Windows', () => {
    expect(normalizeCommand('python')).toBe('python');
    expect(normalizeCommand('node')).toBe('node');
    expect(normalizeCommand('npm')).toBe('npm');
  });

  it('preserves commands that already have .exe extension', () => {
    expect(normalizeCommand('python.exe')).toBe('python.exe');
  });

  it('preserves commands that already have .cmd extension', () => {
    expect(normalizeCommand('npm.cmd')).toBe('npm.cmd');
  });

  it('preserves commands that already have .bat extension', () => {
    expect(normalizeCommand('run.bat')).toBe('run.bat');
  });

  it('returns unknown commands unchanged', () => {
    expect(normalizeCommand('custom-tool')).toBe('custom-tool');
    expect(normalizeCommand('my-script')).toBe('my-script');
  });
});

describe('normalizeCommand (Windows behavior)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    vi.resetModules();
  });

  it('appends .exe to known commands on Windows', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    const { normalizeCommand: normalizeWin } = await import('../platform.js');

    expect(normalizeWin('python')).toBe('python.exe');
    expect(normalizeWin('node')).toBe('node.exe');
    expect(normalizeWin('npm')).toBe('npm.exe');
    expect(normalizeWin('git')).toBe('git.exe');
    expect(normalizeWin('uvicorn')).toBe('uvicorn.exe');
    expect(normalizeWin('pip')).toBe('pip.exe');
  });

  it('does not append .exe to commands already with extensions on Windows', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    const { normalizeCommand: normalizeWin } = await import('../platform.js');

    expect(normalizeWin('python.exe')).toBe('python.exe');
    expect(normalizeWin('npm.cmd')).toBe('npm.cmd');
    expect(normalizeWin('run.bat')).toBe('run.bat');
  });

  it('does not append .exe to unknown commands on Windows', async () => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    const { normalizeCommand: normalizeWin } = await import('../platform.js');

    expect(normalizeWin('custom-tool')).toBe('custom-tool');
    expect(normalizeWin('my-script')).toBe('my-script');
  });
});
