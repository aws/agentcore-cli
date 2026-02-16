import * as lib from '../../../../lib/index.js';
import { checkUvAvailable, createVenv, installDependencies, setupPythonProject } from '../setup.js';
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

describe('checkUvAvailable', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when uv is available', async () => {
    mockCheckSubprocess.mockResolvedValue(true);

    expect(await checkUvAvailable()).toBe(true);
    expect(mockCheckSubprocess).toHaveBeenCalledWith('uv', ['--version']);
  });

  it('returns false when uv is not available', async () => {
    mockCheckSubprocess.mockResolvedValue(false);

    expect(await checkUvAvailable()).toBe(false);
  });
});

describe('createVenv', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when venv creation succeeds', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });

    const result = await createVenv('/project');

    expect(result.status).toBe('success');
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('uv', ['venv', '.venv'], { cwd: '/project' });
  });

  it('uses custom venv name', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });

    await createVenv('/project', 'my-env');

    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('uv', ['venv', 'my-env'], { cwd: '/project' });
  });

  it('returns venv_failed on error', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: '', stderr: 'venv error', signal: null });

    const result = await createVenv('/project');

    expect(result.status).toBe('venv_failed');
    expect(result.error).toBe('venv error');
  });
});

describe('installDependencies', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when install succeeds', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });

    const result = await installDependencies('/project');

    expect(result.status).toBe('success');
    expect(mockRunSubprocessCapture).toHaveBeenCalledWith('uv', ['sync'], { cwd: '/project' });
  });

  it('returns install_failed on error', async () => {
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: 'some output', stderr: '', signal: null });

    const result = await installDependencies('/project');

    expect(result.status).toBe('install_failed');
    expect(result.error).toBe('some output');
  });
});

describe('setupPythonProject', () => {
  const origEnv = process.env.AGENTCORE_SKIP_INSTALL;

  afterEach(() => {
    vi.clearAllMocks();
    if (origEnv !== undefined) process.env.AGENTCORE_SKIP_INSTALL = origEnv;
    else delete process.env.AGENTCORE_SKIP_INSTALL;
  });

  it('skips install when AGENTCORE_SKIP_INSTALL is set', async () => {
    process.env.AGENTCORE_SKIP_INSTALL = '1';

    const result = await setupPythonProject({ projectDir: '/project' });

    expect(result.status).toBe('success');
    expect(mockCheckSubprocess).not.toHaveBeenCalled();
  });

  it('returns uv_not_found when uv is not available', async () => {
    delete process.env.AGENTCORE_SKIP_INSTALL;
    mockCheckSubprocess.mockResolvedValue(false);

    const result = await setupPythonProject({ projectDir: '/project' });

    expect(result.status).toBe('uv_not_found');
    expect(result.error).toContain('uv command not found');
  });

  it('returns venv_failed when venv creation fails', async () => {
    delete process.env.AGENTCORE_SKIP_INSTALL;
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockResolvedValue({ code: 1, stdout: '', stderr: 'venv fail', signal: null });

    const result = await setupPythonProject({ projectDir: '/project' });

    expect(result.status).toBe('venv_failed');
  });

  it('returns success when full setup succeeds', async () => {
    delete process.env.AGENTCORE_SKIP_INSTALL;
    mockCheckSubprocess.mockResolvedValue(true);
    mockRunSubprocessCapture.mockResolvedValue({ code: 0, stdout: '', stderr: '', signal: null });

    const result = await setupPythonProject({ projectDir: '/project' });

    expect(result.status).toBe('success');
  });
});
