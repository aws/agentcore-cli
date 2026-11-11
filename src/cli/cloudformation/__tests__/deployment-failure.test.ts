import { MAX_FAILURE_EVENT_PAGES, MAX_FAILURE_EVENT_REASONS } from '../constants';
import { getDeploymentFailureDetails } from '../deployment-failure';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, destroy, client, profileProvider } = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
  client: vi.fn(),
  profileProvider: vi.fn(),
}));
vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    constructor(options: unknown) {
      client(options);
    }
    send = send;
    destroy = destroy;
  },
  DescribeStackEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: profileProvider }));
vi.mock('../../aws/account', () => ({ getCredentialProvider: vi.fn().mockReturnValue('ambient-credentials') }));

const started = new Date('2026-01-01T12:00:00Z');
function failure(overrides = {}) {
  return {
    Timestamp: started,
    LogicalResourceId: 'Runtime',
    ResourceStatus: 'CREATE_FAILED',
    ResourceStatusReason: 'causal failure',
    ...overrides,
  };
}

describe('getDeploymentFailureDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('paginates through rollback events to the causal resource failure and cleans up', async () => {
    send
      .mockResolvedValueOnce({ StackEvents: [failure({ ResourceStatus: 'ROLLBACK_COMPLETE' })], NextToken: 'older' })
      .mockResolvedValueOnce({
        StackEvents: [failure({ ResourceStatusReason: 'credentialProviderArn ValidationException' })],
      });
    const result = await getDeploymentFailureDetails(['MyStack'], 'us-west-2', started);
    expect(result).toContain('Runtime (CREATE_FAILED): credentialProviderArn ValidationException');
    expect(send.mock.calls[1]![0].input).toEqual({ StackName: 'MyStack', NextToken: 'older' });
    expect(send.mock.calls[0]![1].abortSignal).toBeInstanceOf(AbortSignal);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('excludes historical failures, cancellation fallout, and arbitrary resource properties', async () => {
    send.mockResolvedValue({
      StackEvents: [
        failure({ Timestamp: new Date(started.getTime() - 1000), ResourceStatusReason: 'old failure' }),
        failure({ LogicalResourceId: 'Cancelled', ResourceStatusReason: 'Resource creation cancelled' }),
        failure({ ResourceProperties: 'private property payload' }),
      ],
      NextToken: 'history',
    });
    const result = await getDeploymentFailureDetails(['MyStack'], 'us-east-1', started);
    expect(result).toContain('causal failure');
    expect(result).not.toContain('old failure');
    expect(result).not.toContain('cancelled');
    expect(result).not.toContain('private property payload');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds event pagination even when a token never ends', async () => {
    let token = 0;
    send.mockImplementation(() => Promise.resolve({ StackEvents: [], NextToken: String(++token) }));
    await getDeploymentFailureDetails(['MyStack'], 'us-east-1', started);
    expect(send).toHaveBeenCalledTimes(MAX_FAILURE_EVENT_PAGES);
  });

  it('stops on a repeated pagination token', async () => {
    send.mockResolvedValue({ StackEvents: [], NextToken: 'repeat' });
    await getDeploymentFailureDetails(['MyStack'], 'us-east-1', started);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('bounds and deduplicates failure messages', async () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      failure({ LogicalResourceId: `R${i}`, ResourceStatusReason: 'x'.repeat(2000) })
    );
    send.mockResolvedValue({ StackEvents: [events[0], ...events] });
    const result = await getDeploymentFailureDetails(['MyStack'], 'us-east-1', started);
    expect(result.match(/\(CREATE_FAILED\)/g)).toHaveLength(MAX_FAILURE_EVENT_REASONS);
    expect(result).not.toContain('x'.repeat(1001));
  });

  it('retains earlier diagnostics if a later page is denied', async () => {
    send
      .mockResolvedValueOnce({ StackEvents: [failure()], NextToken: 'next' })
      .mockRejectedValueOnce(new Error('AccessDenied'));
    const result = await getDeploymentFailureDetails(['MyStack'], 'us-east-1', started);
    expect(result).toContain('causal failure');
    expect(result).not.toContain('AccessDenied');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('renders service reasons as plain single-line text', async () => {
    send.mockResolvedValue({
      StackEvents: [failure({ ResourceStatusReason: '\u001b[31mdenied\u001b[0m\nnext line' })],
    });
    const result = await getDeploymentFailureDetails(['MyStack'], 'us-east-1', started);
    expect(result).toContain('denied next line');
    expect(result).not.toContain('\u001b');
  });

  it('uses the selected profile and region and provides manual guidance on an empty response', async () => {
    profileProvider.mockReturnValue('selected-credentials');
    send.mockResolvedValue({});
    const result = await getDeploymentFailureDetails(['MyStack'], 'us-gov-west-1', started, 'selected-profile');
    expect(profileProvider).toHaveBeenCalledWith({ profile: 'selected-profile' });
    expect(client).toHaveBeenCalledWith({
      region: 'us-gov-west-1',
      credentials: 'selected-credentials',
      maxAttempts: 1,
    });
    expect(result).toContain('--region "us-gov-west-1" --profile "selected-profile"');
    expect(result).toContain('no recent failures found');
  });
});
