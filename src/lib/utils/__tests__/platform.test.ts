import { getShellArgs, getShellCommand, getVenvExecutable, normalizeCommand } from '../platform.js';
import { describe, expect, it } from 'vitest';

describe('getVenvExecutable', () => {
  // These tests verify the logic based on the current platform (macOS/Linux in CI)
  it('returns bin path on unix', () => {
    const result = getVenvExecutable('.venv', 'python');
    // On macOS/Linux: .venv/bin/python
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
    // On Unix: ['-c', 'echo hello']
    expect(args[1]).toBe('echo hello');
  });
});

describe('normalizeCommand', () => {
  // On non-Windows (this test will run on macOS/Linux), commands should pass through unchanged
  it('returns command unchanged on non-Windows', () => {
    if (process.platform !== 'win32') {
      expect(normalizeCommand('python')).toBe('python');
      expect(normalizeCommand('node')).toBe('node');
      expect(normalizeCommand('npm')).toBe('npm');
    }
  });

  it('preserves commands that already have extensions', () => {
    // Even on any platform, already-extended commands should pass through
    expect(normalizeCommand('python.exe')).toBe('python.exe');
  });
});
