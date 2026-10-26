import {
  NO_CWD_EXE_SEARCH_ENV,
  checkSubprocess,
  checkSubprocessSync,
  disableCwdExecutableSearch,
  resolveExecutable,
  runSubprocess,
  runSubprocessCapture,
  runSubprocessCaptureSync,
  spawn,
  spawnSync,
} from '../subprocess.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function withPlatform(platform: NodeJS.Platform, fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

async function withPlatformAsync(platform: NodeJS.Platform, fn: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

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
    expect(result.stderr).toContain('__nonexistent_command_xyz__');
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

describe('resolveExecutable (Windows rules)', () => {
  // Simulated Windows filesystem: the project directory also contains command wrappers.
  const files = new Set([
    'C:\\project\\npm.cmd',
    'C:\\project\\node.exe',
    'C:\\project\\where.cmd',
    'C:\\Program Files\\nodejs\\npm.cmd',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Windows\\System32\\where.exe',
  ]);
  // Windows paths are case-insensitive (PATHEXT yields "npm.CMD").
  const lowerFiles = new Set([...files].map(f => f.toLowerCase()));
  const isExecutableFile = (p: string) => lowerFiles.has(p.toLowerCase());
  const env = {
    Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  const resolve = (cmd: string, e: NodeJS.ProcessEnv = env) =>
    resolveExecutable(cmd, { env: e, platform: 'win32', isExecutableFile });

  it('resolves from PATH, never the current directory', () => {
    expect(resolve('npm')?.toLowerCase()).toBe('c:\\program files\\nodejs\\npm.cmd');
    expect(resolve('node')?.toLowerCase()).toBe('c:\\program files\\nodejs\\node.exe');
    expect(resolve('where')?.toLowerCase()).toBe('c:\\windows\\system32\\where.exe');
  });

  it('returns null when the command only exists in the current directory', () => {
    expect(resolve('npm', { Path: 'C:\\Windows\\System32' })).toBeNull();
  });

  it('skips empty, "." and relative PATH entries', () => {
    const files2 = new Set(['.\\npm.cmd', 'npm.cmd', 'bin\\npm.cmd']);
    expect(
      resolveExecutable('npm', {
        env: { PATH: ';.;bin;', PATHEXT: '.CMD' },
        platform: 'win32',
        isExecutableFile: p => files2.has(p),
      })
    ).toBeNull();
  });

  it('honors PATHEXT order and explicit extensions', () => {
    expect(resolve('npm.cmd')).toBe('C:\\Program Files\\nodejs\\npm.cmd');
    expect(resolve('node.exe')).toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('strips quotes around PATH entries', () => {
    expect(resolve('npm', { Path: '"C:\\Program Files\\nodejs"', PATHEXT: '.cmd' })).toBe(
      'C:\\Program Files\\nodejs\\npm.cmd'
    );
  });

  it('uses the lexicographically first of duplicate-case PATH keys, like child_process', () => {
    // 'PATH' sorts before 'Path', so PATH wins regardless of insertion order.
    expect(resolve('npm', { Path: 'C:\\Windows\\System32', PATH: 'C:\\Program Files\\nodejs' })).not.toBeNull();
    expect(resolve('npm', { Path: 'C:\\Program Files\\nodejs', PATH: 'C:\\Windows\\System32' })).toBeNull();
  });

  it('tries a name with an unknown extension as-is before appending PATHEXT', () => {
    const files3 = new Set(['c:\\tools\\run.js']);
    expect(
      resolveExecutable('run.js', {
        env: { Path: 'C:\\tools', PATHEXT: ' .EXE ; .CMD ' },
        platform: 'win32',
        isExecutableFile: p => files3.has(p.toLowerCase()),
      })
    ).toBe('C:\\tools\\run.js');
  });

  it('returns commands with a path separator unchanged', () => {
    expect(resolve('.\\tool.exe')).toBe('.\\tool.exe');
    expect(resolve('C:\\tools\\x.exe')).toBe('C:\\tools\\x.exe');
  });
});

describe('resolveExecutable (POSIX)', () => {
  let dir: string;
  let cwdDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentcore-bin-'));
    cwdDir = mkdtempSync(join(tmpdir(), 'agentcore-cwd-'));
    for (const d of [dir, cwdDir]) {
      writeFileSync(join(d, 'mytool'), '#!/bin/sh\necho hi\n');
      chmodSync(join(d, 'mytool'), 0o755);
    }
    writeFileSync(join(dir, 'notexec'), 'x');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it('finds executables in absolute PATH entries', () => {
    expect(resolveExecutable('mytool', { env: { PATH: dir }, platform: 'linux' })).toBe(join(dir, 'mytool'));
  });

  it('ignores relative PATH entries even when the cwd contains the command', () => {
    const original = process.cwd();
    process.chdir(cwdDir);
    try {
      expect(resolveExecutable('mytool', { env: { PATH: '.::' }, platform: 'linux' })).toBeNull();
    } finally {
      process.chdir(original);
    }
  });

  it('skips files without the execute bit', () => {
    expect(resolveExecutable('notexec', { env: { PATH: dir }, platform: 'linux' })).toBeNull();
  });
});

describe('spawn / spawnSync on Windows when the command is not on PATH', () => {
  it('spawn emits ENOENT then close, like child_process.spawn', async () => {
    await withPlatformAsync('win32', async () => {
      const child = spawn('npm', ['--version'], { env: { Path: '' }, stdio: 'pipe' });
      expect(child.stdin).not.toBeNull();
      const events: string[] = [];
      let error: NodeJS.ErrnoException | undefined;
      child.on('error', err => {
        events.push('error');
        error = err;
      });
      await new Promise<void>(resolve =>
        child.on('close', code => {
          events.push(`close:${code}`);
          resolve();
        })
      );
      expect(error?.code).toBe('ENOENT');
      expect(error?.message).toBe('spawn npm ENOENT');
      expect(events).toEqual(['error', 'close:-4058']);
    });
  });

  it('the not-found child is safe to kill/ref/unref', async () => {
    await withPlatformAsync('win32', async () => {
      const child = spawn('npm', [], { env: { Path: '' } });
      child.on('error', () => undefined);
      expect(child.kill()).toBe(false);
      child.ref();
      child.unref();
      await new Promise(resolve => child.on('close', resolve));
    });
  });

  it('spawnSync returns an ENOENT result, like child_process.spawnSync', () => {
    withPlatform('win32', () => {
      const result = spawnSync('npm', ['--version'], { env: { Path: '' }, encoding: 'utf-8' });
      expect(result.status).toBeNull();
      expect(result.stdout).toBe('');
      expect((result.error as NodeJS.ErrnoException).code).toBe('ENOENT');
    });
  });

  it('checkSubprocess reports a cwd-only command as unavailable', async () => {
    await withPlatformAsync('win32', async () => {
      expect(await checkSubprocess('npm', [], { env: { Path: '' } })).toBe(false);
    });
  });
});

describe('disableCwdExecutableSearch', () => {
  afterEach(() => {
    delete process.env[NO_CWD_EXE_SEARCH_ENV];
  });

  it('sets NoDefaultCurrentDirectoryInExePath on Windows', () => {
    withPlatform('win32', () => disableCwdExecutableSearch());
    expect(process.env[NO_CWD_EXE_SEARCH_ENV]).toBe('1');
  });

  it('is a no-op elsewhere', () => {
    withPlatform('linux', () => disableCwdExecutableSearch());
    expect(process.env[NO_CWD_EXE_SEARCH_ENV]).toBeUndefined();
  });
});
