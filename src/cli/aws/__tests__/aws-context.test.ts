import { detectAccount } from '../account';
import { detectAwsContext } from '../aws-context.js';
import { detectRegion } from '../region';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('../account', () => ({
  detectAccount: vi.fn(),
}));

vi.mock('../region', () => ({
  detectRegion: vi.fn(),
}));

describe('detectAwsContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns combined account and region info', async () => {
    vi.mocked(detectAccount).mockResolvedValue('123456789012');
    vi.mocked(detectRegion).mockResolvedValue({ region: 'us-west-2', source: 'env' });

    const result = await detectAwsContext();
    expect(result.accountId).toBe('123456789012');
    expect(result.region).toBe('us-west-2');
    expect(result.regionSource).toBe('env');
  });

  it('returns null accountId when detection fails', async () => {
    vi.mocked(detectAccount).mockResolvedValue(null);
    vi.mocked(detectRegion).mockResolvedValue({ region: 'us-east-1', source: 'default' });

    const result = await detectAwsContext();
    expect(result.accountId).toBeNull();
    expect(result.region).toBe('us-east-1');
    expect(result.regionSource).toBe('default');
  });

  it('uses config source', async () => {
    vi.mocked(detectAccount).mockResolvedValue('111222333444');
    vi.mocked(detectRegion).mockResolvedValue({ region: 'eu-west-1', source: 'config' });

    const result = await detectAwsContext();
    expect(result.regionSource).toBe('config');
  });
});
