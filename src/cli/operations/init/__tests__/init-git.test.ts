import { initGitRepo } from '../files.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRunSubprocessCapture = vi.fn();

vi.mock('../../../../lib', () => ({
  runSubprocessCapture: (...args: unknown[]) => mockRunSubprocessCapture(...args),
}));

const ok = { code: 0, stdout: '', stderr: '', signal: null };
const fail = (stderr = '') => ({ code: 1, stdout: '', stderr, signal: null });

describe('initGitRepo', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns skipped when git is not available', async () => {
    mockRunSubprocessCapture.mockResolvedValue(fail());

    const result = await initGitRepo('/project');

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('git not available');
  });

  it('returns skipped when already in a git repo', async () => {
    mockRunSubprocessCapture
      .mockResolvedValueOnce(ok) // git --version
      .mockResolvedValueOnce(ok); // git rev-parse

    const result = await initGitRepo('/project');

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('already in a git repository');
  });

  it('returns error when git init fails', async () => {
    mockRunSubprocessCapture
      .mockResolvedValueOnce(ok) // git --version
      .mockResolvedValueOnce(fail()) // git rev-parse (not in repo)
      .mockResolvedValueOnce(fail('init error')); // git init

    const result = await initGitRepo('/project');

    expect(result.status).toBe('error');
    expect(result.message).toContain('init error');
  });

  it('returns error when git add fails', async () => {
    mockRunSubprocessCapture
      .mockResolvedValueOnce(ok) // git --version
      .mockResolvedValueOnce(fail()) // git rev-parse
      .mockResolvedValueOnce(ok) // git init
      .mockResolvedValueOnce(fail('add error')); // git add

    const result = await initGitRepo('/project');

    expect(result.status).toBe('error');
    expect(result.message).toContain('add error');
  });

  it('returns error when git commit fails', async () => {
    mockRunSubprocessCapture
      .mockResolvedValueOnce(ok) // git --version
      .mockResolvedValueOnce(fail()) // git rev-parse
      .mockResolvedValueOnce(ok) // git init
      .mockResolvedValueOnce(ok) // git add
      .mockResolvedValueOnce(fail('commit error')); // git commit

    const result = await initGitRepo('/project');

    expect(result.status).toBe('error');
    expect(result.message).toContain('commit error');
  });

  it('returns success on full flow', async () => {
    mockRunSubprocessCapture
      .mockResolvedValueOnce(ok) // git --version
      .mockResolvedValueOnce(fail()) // git rev-parse (not in repo)
      .mockResolvedValueOnce(ok) // git init
      .mockResolvedValueOnce(ok) // git add
      .mockResolvedValueOnce(ok); // git commit

    const result = await initGitRepo('/project');

    expect(result.status).toBe('success');
  });
});
