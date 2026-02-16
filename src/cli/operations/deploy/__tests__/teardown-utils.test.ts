import { type DeployedTarget, destroyTarget, discoverDeployedTargets, getCdkProjectDir } from '../teardown.js';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadProjectSpec,
  mockReadAWSDeploymentTargets,
  mockReadDeployedState,
  mockWriteDeployedState,
  mockFindStack,
  mockExistsSync,
  mockInitialize,
  mockDestroy,
} = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockReadAWSDeploymentTargets: vi.fn(),
  mockReadDeployedState: vi.fn(),
  mockWriteDeployedState: vi.fn(),
  mockFindStack: vi.fn(),
  mockExistsSync: vi.fn(),
  mockInitialize: vi.fn(),
  mockDestroy: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  CONFIG_DIR: 'agentcore',
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    readDeployedState = mockReadDeployedState;
    writeDeployedState = mockWriteDeployedState;
  },
}));

vi.mock('../../../cloudformation/stack-discovery.js', () => ({
  findStack: mockFindStack,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('../../../cdk/toolkit-lib/index.js', () => ({
  CdkToolkitWrapper: class {
    initialize = mockInitialize;
    destroy = mockDestroy;
  },
  silentIoHost: {},
}));

vi.mock('@aws-cdk/toolkit-lib', () => ({
  StackSelectionStrategy: { PATTERN_MUST_MATCH: 'PATTERN_MUST_MATCH' },
}));

describe('getCdkProjectDir', () => {
  it('returns agentcore/cdk under cwd by default', () => {
    const result = getCdkProjectDir();

    expect(result).toBe(join(process.cwd(), 'agentcore', 'cdk'));
  });

  it('returns agentcore/cdk under custom directory', () => {
    const result = getCdkProjectDir('/custom/path');

    expect(result).toBe(join('/custom/path', 'agentcore', 'cdk'));
  });
});

describe('discoverDeployedTargets', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns deployed targets with matching stacks', async () => {
    mockReadProjectSpec.mockResolvedValue({ name: 'my-project' });
    mockReadAWSDeploymentTargets.mockResolvedValue([
      { name: 'target-1', region: 'us-east-1' },
      { name: 'target-2', region: 'us-west-2' },
    ]);
    mockFindStack
      .mockResolvedValueOnce({
        stackName: 'my-project-target-1',
        stackArn: 'arn:aws:cf:us-east-1:123:stack/my-project-target-1/id',
        targetName: 'target-1',
      })
      .mockResolvedValueOnce(null);

    const result = await discoverDeployedTargets();

    expect(result.projectName).toBe('my-project');
    expect(result.deployedTargets).toHaveLength(1);
    expect(result.deployedTargets[0]!.target.name).toBe('target-1');
    expect(mockFindStack).toHaveBeenCalledTimes(2);
  });

  it('ignores errors when checking individual targets', async () => {
    mockReadProjectSpec.mockResolvedValue({ name: 'my-project' });
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'target-1', region: 'us-east-1' }]);
    mockFindStack.mockRejectedValue(new Error('no credentials'));

    const result = await discoverDeployedTargets();

    expect(result.deployedTargets).toEqual([]);
  });

  it('uses custom base dir when provided', async () => {
    mockReadProjectSpec.mockResolvedValue({ name: 'proj' });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);

    const result = await discoverDeployedTargets('/custom/dir');

    expect(result.projectName).toBe('proj');
    expect(result.deployedTargets).toEqual([]);
  });
});

describe('destroyTarget', () => {
  afterEach(() => vi.clearAllMocks());

  const makeTarget = (name: string, stackName: string): DeployedTarget =>
    ({
      target: { name, account: '123456789012', region: 'us-east-1' },
      stack: { stackName, stackArn: `arn:aws:cf:us-east-1:123:stack/${stackName}/id`, targetName: name },
    }) as DeployedTarget;

  it('throws when CDK project dir does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      destroyTarget({
        target: makeTarget('tgt', 'stack-1'),
        cdkProjectDir: '/project/agentcore/cdk',
      })
    ).rejects.toThrow('CDK project not found');
  });

  it('destroys stack and cleans up deployed state', async () => {
    mockExistsSync.mockReturnValue(true);
    mockInitialize.mockResolvedValue(undefined);
    mockDestroy.mockResolvedValue(undefined);
    mockReadDeployedState.mockResolvedValue({
      targets: { 'tgt-1': { status: 'deployed' } },
    });
    mockWriteDeployedState.mockResolvedValue(undefined);

    await destroyTarget({
      target: makeTarget('tgt-1', 'stack-tgt-1'),
      cdkProjectDir: '/project/agentcore/cdk',
    });

    expect(mockInitialize).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith(
      expect.objectContaining({
        stacks: {
          strategy: 'PATTERN_MUST_MATCH',
          patterns: ['stack-tgt-1'],
        },
      })
    );
    expect(mockWriteDeployedState).toHaveBeenCalledWith({ targets: {} });
  });

  it('ignores errors reading deployed state after destroy', async () => {
    mockExistsSync.mockReturnValue(true);
    mockInitialize.mockResolvedValue(undefined);
    mockDestroy.mockResolvedValue(undefined);
    mockReadDeployedState.mockRejectedValue(new Error('no state file'));

    await expect(
      destroyTarget({
        target: makeTarget('tgt-1', 'stack-1'),
        cdkProjectDir: '/project/agentcore/cdk',
      })
    ).resolves.toBeUndefined();
  });
});
