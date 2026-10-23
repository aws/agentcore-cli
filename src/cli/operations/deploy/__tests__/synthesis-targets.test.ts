import { LocalCdkProject } from '../../../cdk/local-cdk-project';
import { synthesizeCdk } from '../preflight';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createWrapper, synth, cleanup } = vi.hoisted(() => ({
  createWrapper: vi.fn(),
  synth: vi.fn().mockResolvedValue({ stackNames: ['AgentCore-test-dev'], assemblyDirectory: '/project/cdk.out' }),
  cleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../cdk/toolkit-lib', () => ({
  CdkToolkitWrapper: class {},
  createCdkToolkitWrapper: createWrapper,
  silentIoHost: {},
}));
vi.mock('../../../tui/utils', () => ({ cleanupStaleLockFiles: cleanup }));

afterEach(() => vi.clearAllMocks());

describe('deployment synthesis scope', () => {
  it('forwards the requested targets through the shared preflight operation', async () => {
    createWrapper.mockResolvedValue({ synth });
    const result = await synthesizeCdk(LocalCdkProject.fromPath('/project/agentcore/cdk'), {
      targetNames: ['dev', 'int'],
      region: 'eu-west-1',
    });
    expect(createWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ targetNames: ['dev', 'int'], region: 'eu-west-1' })
    );
    expect(result.stackNames).toEqual(['AgentCore-test-dev']);
  });

  it('leaves unscoped synthesis unfiltered', async () => {
    createWrapper.mockResolvedValue({ synth });
    await synthesizeCdk(LocalCdkProject.fromPath('/project/agentcore/cdk'));
    expect(createWrapper).toHaveBeenCalledWith(expect.objectContaining({ targetNames: undefined }));
  });
});
