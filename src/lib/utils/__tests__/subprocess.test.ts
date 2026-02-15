import {
  checkSubprocess,
  checkSubprocessSync,
  runSubprocess,
  runSubprocessCapture,
  runSubprocessCaptureSync,
} from '../subprocess.js';
import { describe, expect, it } from 'vitest';

describe('runSubprocess', () => {
  it('resolves on success (exit code 0)', async () => {
    await expect(runSubprocess('true', [], { stdio: 'ignore' })).resolves.toBeUndefined();
  });

  it('rejects on non-zero exit code', async () => {
    await expect(runSubprocess('false', [], { stdio: 'ignore' })).rejects.toThrow('exited with code 1');
  });

  it('rejects on unknown command', async () => {
    await expect(runSubprocess('__nonexistent_command_xyz__', [], { stdio: 'ignore' })).rejects.toThrow();
  });
});

describe('checkSubprocess', () => {
  it('returns true for exit code 0', async () => {
    expect(await checkSubprocess('true', [])).toBe(true);
  });

  it('returns false for non-zero exit code', async () => {
    expect(await checkSubprocess('false', [])).toBe(false);
  });

  it('returns false for unknown command', async () => {
    expect(await checkSubprocess('__nonexistent_command_xyz__', [])).toBe(false);
  });
});

describe('runSubprocessCapture', () => {
  it('captures stdout', async () => {
    const result = await runSubprocessCapture('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
  });

  it('captures stderr', async () => {
    const result = await runSubprocessCapture('sh', ['-c', 'echo error >&2']);
    expect(result.stderr.trim()).toBe('error');
  });

  it('returns non-zero code for failing command', async () => {
    const result = await runSubprocessCapture('false', []);
    expect(result.code).not.toBe(0);
  });

  it('returns code -1 for unknown command', async () => {
    const result = await runSubprocessCapture('__nonexistent_command_xyz__', []);
    expect(result.code).toBe(-1);
  });

  it('respects cwd option', async () => {
    const result = await runSubprocessCapture('pwd', [], { cwd: '/tmp' });
    // /tmp might resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
    expect(result.code).toBe(0);
  });
});

describe('runSubprocessCaptureSync', () => {
  it('captures stdout synchronously', () => {
    const result = runSubprocessCaptureSync('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
  });

  it('returns non-zero code for failing command', () => {
    const result = runSubprocessCaptureSync('false', []);
    expect(result.code).not.toBe(0);
  });

  it('captures stderr synchronously', () => {
    const result = runSubprocessCaptureSync('sh', ['-c', 'echo err >&2']);
    expect(result.stderr.trim()).toBe('err');
  });
});

describe('checkSubprocessSync', () => {
  it('returns true for exit code 0', () => {
    expect(checkSubprocessSync('true', [])).toBe(true);
  });

  it('returns false for non-zero exit code', () => {
    expect(checkSubprocessSync('false', [])).toBe(false);
  });

  it('returns false for unknown command', () => {
    expect(checkSubprocessSync('__nonexistent_command_xyz__', [])).toBe(false);
  });
});
