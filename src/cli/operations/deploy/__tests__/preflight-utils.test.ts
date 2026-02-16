import { checkBootstrapNeeded, checkStackDeployability, formatError } from '../preflight.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockCheckStacksStatus = vi.fn();
const mockCheckBootstrapStatus = vi.fn();

vi.mock('../../../cloudformation', () => ({
  checkStacksStatus: (...args: unknown[]) => mockCheckStacksStatus(...args),
  checkBootstrapStatus: (...args: unknown[]) => mockCheckBootstrapStatus(...args),
  formatCdkEnvironment: vi.fn(),
}));

describe('formatError', () => {
  it('formats Error with message only', () => {
    const err = new Error('something failed');
    err.stack = undefined;

    expect(formatError(err)).toBe('something failed');
  });

  it('includes stack trace when available', () => {
    const err = new Error('with stack');

    const result = formatError(err);

    expect(result).toContain('with stack');
    expect(result).toContain('Stack trace:');
  });

  it('formats nested cause', () => {
    const cause = new Error('root cause');
    cause.stack = undefined;
    const err = new Error('outer error', { cause });
    err.stack = undefined;

    const result = formatError(err);

    expect(result).toContain('outer error');
    expect(result).toContain('Caused by:');
    expect(result).toContain('root cause');
  });

  it('formats non-Error values as string', () => {
    expect(formatError('string error')).toBe('string error');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
  });
});

describe('checkStackDeployability', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns canDeploy true when no blocking stacks', async () => {
    mockCheckStacksStatus.mockResolvedValue(null);

    const result = await checkStackDeployability('us-east-1', ['stack1']);

    expect(result.canDeploy).toBe(true);
    expect(result.blockingStack).toBeUndefined();
  });

  it('returns canDeploy false with blocking stack info', async () => {
    mockCheckStacksStatus.mockResolvedValue({
      stackName: 'stack1',
      result: { message: 'Stack is in ROLLBACK_COMPLETE' },
    });

    const result = await checkStackDeployability('us-east-1', ['stack1']);

    expect(result.canDeploy).toBe(false);
    expect(result.blockingStack).toBe('stack1');
    expect(result.message).toContain('ROLLBACK_COMPLETE');
  });
});

describe('checkBootstrapNeeded', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns not needed when no targets', async () => {
    const result = await checkBootstrapNeeded([]);

    expect(result.needsBootstrap).toBe(false);
    expect(result.target).toBeNull();
  });

  it('returns needed when not bootstrapped', async () => {
    mockCheckBootstrapStatus.mockResolvedValue({ isBootstrapped: false });
    const target = { name: 'dev', region: 'us-east-1', account: '123456789012' } as any;

    const result = await checkBootstrapNeeded([target]);

    expect(result.needsBootstrap).toBe(true);
    expect(result.target).toBe(target);
  });

  it('returns not needed when already bootstrapped', async () => {
    mockCheckBootstrapStatus.mockResolvedValue({ isBootstrapped: true });
    const target = { name: 'dev', region: 'us-east-1', account: '123456789012' } as any;

    const result = await checkBootstrapNeeded([target]);

    expect(result.needsBootstrap).toBe(false);
    expect(result.target).toBeNull();
  });

  it('returns not needed when check throws', async () => {
    mockCheckBootstrapStatus.mockRejectedValue(new Error('network error'));
    const target = { name: 'dev', region: 'us-east-1', account: '123456789012' } as any;

    const result = await checkBootstrapNeeded([target]);

    expect(result.needsBootstrap).toBe(false);
    expect(result.target).toBeNull();
  });
});
