import { LogsScreen } from '../LogsScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLoadDeployedProjectConfig, mockResolveAgentContext } = vi.hoisted(() => ({
  mockLoadDeployedProjectConfig: vi.fn(),
  mockResolveAgentContext: vi.fn(),
}));

vi.mock('../../../../commands/logs/action.js', () => ({
  resolveAgentContext: mockResolveAgentContext,
}));

vi.mock('../../../../operations/resolve-agent.js', () => ({
  loadDeployedProjectConfig: mockLoadDeployedProjectConfig,
}));

vi.mock('../../../../aws/cloudwatch.js', () => ({
  // eslint-disable-next-line require-yield
  async *streamLogs() {
    await new Promise(() => {
      /* never resolves */
    });
  },
}));

const noop = () => undefined;

describe('LogsScreen', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows error when no runtimes are defined', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({
      project: { runtimes: [] },
      deployedState: { targets: {} },
      awsTargets: [],
    });

    const { lastFrame } = render(<LogsScreen isInteractive={true} onExit={noop} />);
    await new Promise(r => setTimeout(r, 50));

    expect(lastFrame()).toContain('No runtimes defined');
  });

  it('shows error when no agents are deployed', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({
      project: { runtimes: [{ name: 'Agent1' }] },
      deployedState: { targets: {} },
      awsTargets: [],
    });
    mockResolveAgentContext.mockReturnValue({ success: false, error: 'Not deployed' });

    const { lastFrame } = render(<LogsScreen isInteractive={true} onExit={noop} />);
    await new Promise(r => setTimeout(r, 50));

    expect(lastFrame()).toContain('No deployed agents found');
  });

  it('auto-selects single agent and shows streaming view', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({
      project: { runtimes: [{ name: 'MyAgent' }] },
      deployedState: { targets: { default: { resources: { runtimes: {} } } } },
      awsTargets: [{ name: 'default', region: 'us-east-1', account: '123' }],
    });
    mockResolveAgentContext.mockReturnValue({
      success: true,
      agentContext: {
        agentId: 'rt-123',
        agentName: 'MyAgent',
        accountId: '123',
        region: 'us-east-1',
        endpointName: 'default',
        logGroupName: '/aws/logs/test',
      },
    });

    const { lastFrame } = render(<LogsScreen isInteractive={true} onExit={noop} />);
    await new Promise(r => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain('Agent:');
    expect(frame).toContain('MyAgent');
    expect(frame).toContain('us-east-1');
  });

  it('shows agent selection when multiple agents exist', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({
      project: { runtimes: [{ name: 'Agent1' }, { name: 'Agent2' }] },
      deployedState: { targets: { default: { resources: { runtimes: {} } } } },
      awsTargets: [{ name: 'default', region: 'us-west-2', account: '456' }],
    });
    mockResolveAgentContext
      .mockReturnValueOnce({
        success: true,
        agentContext: {
          agentId: 'rt-1',
          agentName: 'Agent1',
          accountId: '456',
          region: 'us-west-2',
          endpointName: 'default',
          logGroupName: '/aws/logs/1',
        },
      })
      .mockReturnValueOnce({
        success: true,
        agentContext: {
          agentId: 'rt-2',
          agentName: 'Agent2',
          accountId: '456',
          region: 'us-west-2',
          endpointName: 'default',
          logGroupName: '/aws/logs/2',
        },
      });

    const { lastFrame } = render(<LogsScreen isInteractive={true} onExit={noop} />);
    await new Promise(r => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain('Select an agent');
    expect(frame).toContain('Agent1');
    expect(frame).toContain('Agent2');
  });

  it('shows error when config loading throws', async () => {
    mockLoadDeployedProjectConfig.mockRejectedValue(new Error('File not found'));

    const { lastFrame } = render(<LogsScreen isInteractive={true} onExit={noop} />);
    await new Promise(r => setTimeout(r, 50));

    expect(lastFrame()).toContain('File not found');
  });
});
