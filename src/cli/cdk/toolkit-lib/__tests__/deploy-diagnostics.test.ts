import { CdkToolkitWrapper } from '../wrapper';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { deploy, send } = vi.hoisted(() => ({ deploy: vi.fn(), send: vi.fn() }));
vi.mock('@aws-cdk/toolkit-lib', () => ({
  StackSelectionStrategy: { PATTERN_MUST_MATCH: 'pattern-must-match' },
  Toolkit: class {
    fromCdkApp = vi.fn().mockResolvedValue({});
    fromAssemblyDirectory = vi.fn().mockResolvedValue({});
    synth = vi.fn().mockResolvedValue({
      produce: () =>
        Promise.resolve({
          cloudAssembly: { directory: '/test/cdk.out', stacks: [{ stackName: 'SynthStack' }] },
          dispose: vi.fn(),
        }),
    });
    deploy = deploy;
  },
  BaseCredentials: { awsCliCompatible: vi.fn() },
}));
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = send;
    destroy = vi.fn();
  },
  DescribeStackEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('../../../aws/account', () => ({ getCredentialProvider: vi.fn() }));

describe('deployment failure diagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the causal CloudFormation failure when toolkit throws NoStack', async () => {
    const error = new Error('NoStack: CloudFormationStack object does not hold a stack');
    deploy.mockRejectedValue(error);
    send.mockResolvedValue({
      StackEvents: [
        {
          Timestamp: new Date(),
          LogicalResourceId: 'Runtime',
          ResourceStatus: 'CREATE_FAILED',
          ResourceStatusReason: 'SubscriptionRequiredException: model access is required',
        },
      ],
    });
    const wrapper = new CdkToolkitWrapper({ region: 'us-east-1' });
    await wrapper.initialize();
    await expect(
      wrapper.deploy({ stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['MyStack'] } })
    ).rejects.toThrow('SubscriptionRequiredException');
    expect(send.mock.calls[0]![0].input).toEqual({ StackName: 'MyStack', NextToken: undefined });
  });

  it('keeps the original failure and adds a manual diagnostic command if events are unavailable', async () => {
    const error = new Error('original deployment failure');
    deploy.mockRejectedValue(error);
    send.mockRejectedValue(new Error('AccessDenied'));
    const wrapper = new CdkToolkitWrapper({ region: 'us-east-1' });
    await wrapper.initialize();
    await expect(
      wrapper.deploy({ stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['MyStack'] } })
    ).rejects.toThrow('describe-stack-events');
    expect(error.message).toContain('original deployment failure');
    expect(error.message).not.toContain('AccessDenied');
  });

  it('does not query stack events after a successful deployment', async () => {
    deploy.mockResolvedValue({ success: true });
    const wrapper = new CdkToolkitWrapper({ region: 'us-east-1' });
    await wrapper.initialize();
    await wrapper.deploy();
    expect(send).not.toHaveBeenCalled();
  });

  it('uses synthesized stack names when the TUI deploys without patterns', async () => {
    const original = new TypeError('original typed failure');
    deploy.mockRejectedValue(original);
    send.mockResolvedValue({
      StackEvents: [
        {
          Timestamp: new Date(),
          LogicalResourceId: 'Runtime',
          ResourceStatus: 'UPDATE_FAILED',
          ResourceStatusReason: 'underlying service reason',
        },
      ],
    });
    const wrapper = new CdkToolkitWrapper({ region: 'us-east-1' });
    await wrapper.initialize();
    await wrapper.synth();
    await expect(wrapper.deploy()).rejects.toBe(original);
    expect(original.message).toContain('underlying service reason');
    expect(send.mock.calls[0]![0].input.StackName).toBe('SynthStack');
    await wrapper.dispose();
  });

  it('keeps changeset retry behavior without diagnostic reads when retry succeeds', async () => {
    vi.useFakeTimers();
    deploy
      .mockRejectedValueOnce(new Error('changeset is currently in progress'))
      .mockResolvedValueOnce({ success: true });
    const wrapper = new CdkToolkitWrapper({ region: 'us-east-1' });
    await wrapper.initialize();
    const result = wrapper.deploy({
      stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: ['MyStack'] },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toEqual({ success: true });
    expect(deploy).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
});
