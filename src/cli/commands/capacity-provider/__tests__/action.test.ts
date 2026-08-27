import { resolveDeleteTarget } from '../action';
import { isValidCapacityProviderSessionId } from '../constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readDeployedState = vi.fn();
const resolveAWSDeploymentTargets = vi.fn().mockResolvedValue([]);
const findConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  findConfigRoot: () => findConfigRoot(),
  ConfigIO: class {
    readDeployedState = readDeployedState;
    resolveAWSDeploymentTargets = resolveAWSDeploymentTargets;
  },
}));

vi.mock('../../../aws/region', () => ({ detectRegion: vi.fn().mockResolvedValue({ region: 'us-east-1' }) }));

const CP_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/my_pool-a1b2c3d4e5';

describe('isValidCapacityProviderSessionId', () => {
  it('accepts valid session ids', () => {
    expect(isValidCapacityProviderSessionId('sess-abc123')).toBe(true);
    expect(isValidCapacityProviderSessionId('A')).toBe(true);
    expect(isValidCapacityProviderSessionId('abc_def-123')).toBe(true);
  });

  it('rejects invalid session ids', () => {
    expect(isValidCapacityProviderSessionId('')).toBe(false);
    expect(isValidCapacityProviderSessionId('-leading-hyphen')).toBe(false);
    expect(isValidCapacityProviderSessionId('has space')).toBe(false);
    expect(isValidCapacityProviderSessionId('a'.repeat(101))).toBe(false);
  });
});

describe('resolveDeleteTarget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves an external CP by ARN (id + region from the ARN, no project needed)', async () => {
    const target = await resolveDeleteTarget({ capacityProvider: CP_ARN, sessionId: 'sess-1' });
    expect(target).toEqual({
      capacityProviderId: 'my_pool-a1b2c3d4e5',
      capacityProviderArn: CP_ARN,
      region: 'us-west-2',
      targetByArn: true,
      displayName: CP_ARN,
    });
    expect(findConfigRoot).not.toHaveBeenCalled();
  });

  it('honors an explicit --region override for the ARN path', async () => {
    const target = await resolveDeleteTarget({ capacityProvider: CP_ARN, sessionId: 'sess-1', region: 'eu-west-1' });
    expect(target.region).toBe('eu-west-1');
  });

  it('accepts a literal capacity provider id directly (no project; the data-plane API path param)', async () => {
    const target = await resolveDeleteTarget({
      capacityProvider: 'my_pool-a1b2c3d4e5',
      sessionId: 'sess-1',
      region: 'us-west-2',
    });
    expect(target).toEqual({
      capacityProviderId: 'my_pool-a1b2c3d4e5',
      region: 'us-west-2',
      targetByArn: false,
      displayName: 'my_pool-a1b2c3d4e5',
    });
    expect(findConfigRoot).not.toHaveBeenCalled();
  });

  it('resolves an in-project CP by name from deployed-state (across targets)', async () => {
    findConfigRoot.mockReturnValue('/proj/agentcore');
    readDeployedState.mockResolvedValue({
      targets: {
        prod: {
          resources: {
            capacityProviders: { my_pool: { capacityProviderId: 'my_pool-zzz', capacityProviderArn: CP_ARN } },
          },
        },
      },
    });
    const target = await resolveDeleteTarget({ capacityProvider: 'my_pool', sessionId: 'sess-1' });
    expect(target.capacityProviderId).toBe('my_pool-zzz');
    expect(target.region).toBe('us-west-2'); // from the CP ARN
    expect(target.targetByArn).toBe(false);
    expect(target.displayName).toBe('my_pool');
  });

  it('throws when the named CP is not deployed', async () => {
    findConfigRoot.mockReturnValue('/proj/agentcore');
    readDeployedState.mockResolvedValue({ targets: { prod: { resources: { capacityProviders: {} } } } });
    await expect(resolveDeleteTarget({ capacityProvider: 'ghost', sessionId: 'sess-1' })).rejects.toThrow(
      /not deployed/
    );
  });

  it('throws when referencing a name outside a project', async () => {
    findConfigRoot.mockReturnValue(undefined);
    await expect(resolveDeleteTarget({ capacityProvider: 'my_pool', sessionId: 'sess-1' })).rejects.toThrow(
      /No AgentCore project/
    );
  });

  // A CP of the same name can be deployed to more than one target/region. Resolution must not blindly
  // take the first match, or --region could be paired with an id from a different target.
  const WEST_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/my_pool-a1b2c3d4e5';
  const EAST_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:capacity-provider/my_pool-e5f6g7h8i9';
  const twoRegionState = {
    targets: {
      west: {
        resources: {
          capacityProviders: { my_pool: { capacityProviderId: 'my_pool-a1b2c3d4e5', capacityProviderArn: WEST_ARN } },
        },
      },
      east: {
        resources: {
          capacityProviders: { my_pool: { capacityProviderId: 'my_pool-e5f6g7h8i9', capacityProviderArn: EAST_ARN } },
        },
      },
    },
  };

  it('resolves the by-name match in the requested region (not the first target)', async () => {
    findConfigRoot.mockReturnValue('/proj/agentcore');
    readDeployedState.mockResolvedValue(twoRegionState);
    const target = await resolveDeleteTarget({ capacityProvider: 'my_pool', sessionId: 'sess-1', region: 'us-east-1' });
    expect(target.capacityProviderId).toBe('my_pool-e5f6g7h8i9');
    expect(target.capacityProviderArn).toBe(EAST_ARN);
    expect(target.region).toBe('us-east-1');
  });

  it('throws (rather than guessing) when a name is deployed in multiple regions and none requested', async () => {
    findConfigRoot.mockReturnValue('/proj/agentcore');
    readDeployedState.mockResolvedValue(twoRegionState);
    await expect(resolveDeleteTarget({ capacityProvider: 'my_pool', sessionId: 'sess-1' })).rejects.toThrow(
      /multiple regions/
    );
  });

  it('throws when the requested region has no matching deployment', async () => {
    findConfigRoot.mockReturnValue('/proj/agentcore');
    readDeployedState.mockResolvedValue(twoRegionState);
    await expect(
      resolveDeleteTarget({ capacityProvider: 'my_pool', sessionId: 'sess-1', region: 'eu-west-1' })
    ).rejects.toThrow(/not deployed in region eu-west-1/);
  });
});
