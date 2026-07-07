import * as lib from '../../../../lib/index.js';
import { checkNpmAvailable, installNodeDependencies, setupNodeProject } from '../setup.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/index.js', async () => {
  const actual = await vi.importActual('../../../../lib/index.js');
  return {
    ...actual,
    checkSubprocess: vi.fn(),
    runSubprocessCapture: vi.fn(),
  };
});

const mockCheckSubprocess = vi.mocked(lib.checkSubprocess);
const mockRunSubprocessCapture = vi.mocked(lib.runSubprocessCapture);

describe('checkNpmAvailable', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when npm is available', async () => {
    mockCheckSubprocess.mockResolvedValue(true);

    expect(await checkNpmAvailable()).toBe(true);
    expect(mockCheckSubprocess).toHaveBeenCalledWith('npm', ['--version']);
  });

  it('returns false when npm is not available', async () => {
    mockCheckSubprocess.mockResolvedValue(false);

    expect(await checkNpmAvailable()).toBe(false);
  });
});

describe('installNodeDependencies', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when install succeeds', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });

    const result = await installNodeDependencies('/project');

    expect(result.status).toBe('success');
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('npm', ['install'], { cwd: '/project' });
  });

  it('returns install_failed on error', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: 'some output', stderr: '', signal: null });

    const result = await installNodeDependencies('/project');

    expect(result.status).toBe('install_failed');
    expect(result.error).toBe('some output');
  });
});

describe('setupNodeProject', () => {
  const origEnv = process.env.AGENTCORE_SKIP_INSTALL;

  afterEach(() => {
    vi.clearAllMocks();
    if (origEnv !== undefined) process.env.AGENTCORE_SKIP_INSTALL = origEnv;
    else delete process.env.AGENTCORE_SKIP_INSTALL;
  });

  it('skips install when AGENTCORE_SKIP_INSTALL is set', async () => {
    process.env.AGENTCORE_SKIP_INSTALL = '1';

    const result = await setupNodeProject({ projectDir: '/project' });

    expect(result.status).toBe('success');
    expect(mockCheckSubprocess).not.toHaveBeenCalled();
  });

  it('returns npm_not_found when npm is not available', async () => {
    delete process.env.AGENTCORE_SKIP_INSTALL;
    mockCheckSubprocess.mockResolvedValue(false);

    const result = await setupNodeProject({ projectDir: '/project' });

    expect(result.status).toBe('npm_not_found');
    expect(result.error).toContain('npm');
  });

  it('returns install_failed when npm install fails', async () => {
    delete process.env.AGENTCORE_SKIP_INSTALL;
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: '', stderr: 'npm fail', signal: null });

    const result = await setupNodeProject({ projectDir: '/project' });

    expect(result.status).toBe('install_failed');
  });

  it('returns success when full setup succeeds', async () => {
    delete process.env.AGENTCORE_SKIP_INSTALL;
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });

    const result = await setupNodeProject({ projectDir: '/project' });

    expect(result.status).toBe('success');
  });
});
