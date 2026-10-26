import { NO_CWD_EXE_SEARCH_ENV, spawn, spawnSync } from '../subprocess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCrossSpawn, mockCrossSpawnSync, mockStat } = vi.hoisted(() => ({
  mockCrossSpawn: vi.fn(),
  mockCrossSpawnSync: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('cross-spawn', () => ({
  default: Object.assign(mockCrossSpawn, { sync: mockCrossSpawnSync }),
}));

vi.mock('fs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  statSync: mockStat,
}));

// Only the npm command on PATH is eligible; C:\project\npm.cmd is not consulted.
const REAL_NPM = 'C:\\Program Files\\nodejs\\npm.cmd';
const env = { Path: 'C:\\Program Files\\nodejs', PATHEXT: '.EXE;.CMD' };

describe('spawn / spawnSync on Windows', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockStat.mockImplementation((p: string) => {
      if (p.toLowerCase() === REAL_NPM.toLowerCase()) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    vi.clearAllMocks();
  });

  it('spawn passes the absolute PATH match to cross-spawn and disables cwd lookup in the child', () => {
    spawn('npm', ['install'], { cwd: 'C:\\project', env });

    expect(mockCrossSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockCrossSpawn.mock.calls[0]! as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command.toLowerCase()).toBe(REAL_NPM.toLowerCase());
    expect(args).toEqual(['install']);
    expect(options.env[NO_CWD_EXE_SEARCH_ENV]).toBe('1');
    expect(options.env.Path).toBe(env.Path);
  });

  it('spawnSync passes the absolute PATH match to cross-spawn and disables cwd lookup in the child', () => {
    mockCrossSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', signal: null, pid: 1, output: [] });
    spawnSync('npm', ['--version'], { cwd: 'C:\\project', env, encoding: 'utf-8' });

    const [command, , options] = mockCrossSpawnSync.mock.calls[0]! as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command.toLowerCase()).toBe(REAL_NPM.toLowerCase());
    expect(options.env[NO_CWD_EXE_SEARCH_ENV]).toBe('1');
  });

  it('never hands a bare, unresolved name to cross-spawn', () => {
    const child = spawn('where', ['npm'], { cwd: 'C:\\project', env });
    child.on('error', () => undefined);
    expect(mockCrossSpawn).not.toHaveBeenCalled();
  });
});
