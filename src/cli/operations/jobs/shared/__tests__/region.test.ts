import { regionFromArn, resolveJobRegion } from '../region';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockDetectRegion } = vi.hoisted(() => ({ mockDetectRegion: vi.fn() }));
vi.mock('../../../../aws/region', () => ({ detectRegion: () => mockDetectRegion() }));

describe('regionFromArn', () => {
  it('parses the region (field index 3) from a well-formed ARN', () => {
    expect(regionFromArn('arn:aws:bedrock-agentcore:us-west-2:111122223333:recommendation/rec-1')).toBe('us-west-2');
  });

  it('parses GovCloud / China partitions', () => {
    expect(regionFromArn('arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:111:recommendation/r')).toBe('us-gov-west-1');
    expect(regionFromArn('arn:aws-cn:bedrock-agentcore:cn-north-1:111:recommendation/r')).toBe('cn-north-1');
  });

  it('returns undefined for a region-less / malformed ARN', () => {
    expect(regionFromArn('not-an-arn')).toBeUndefined();
    expect(regionFromArn('arn:aws:svc::111:res')).toBeUndefined();
  });
});

describe('resolveJobRegion', () => {
  afterEach(() => vi.clearAllMocks());

  it('prefers the explicit option', async () => {
    expect(await resolveJobRegion('eu-west-1', [{ region: 'us-east-1' }])).toBe('eu-west-1');
    expect(mockDetectRegion).not.toHaveBeenCalled();
  });

  it('falls back to the first deployment target', async () => {
    expect(await resolveJobRegion(undefined, [{ region: 'ap-southeast-2' }])).toBe('ap-southeast-2');
    expect(mockDetectRegion).not.toHaveBeenCalled();
  });

  it('falls back to detectRegion when no option or target', async () => {
    mockDetectRegion.mockResolvedValue({ region: 'us-west-2' });
    expect(await resolveJobRegion(undefined, [])).toBe('us-west-2');
    expect(mockDetectRegion).toHaveBeenCalled();
  });
});
