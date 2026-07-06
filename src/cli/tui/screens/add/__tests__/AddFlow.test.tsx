import type { AddAgentConfig } from '../../agent/types';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock implementations so the vi.mock factories (which are hoisted above
// imports by vitest) can reference them.
const mockAddAgent = vi.hoisted(() => vi.fn());
const mockReset = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());

// Replace AddAgentFlow with a stub that immediately signals completion, so we can
// drive AddFlow into its success state without walking the whole agent wizard.
vi.mock('../../agent/AddAgentFlow', async () => {
  const React = (await import('react')).default;
  return {
    AddAgentFlow: ({ onComplete }: { onComplete: (config: AddAgentConfig) => void }) => {
      React.useEffect(() => {
        onComplete({ name: 'TestAgent' } as never);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    },
  };
});

vi.mock('../../agent/useAddAgent', () => ({
  useAddAgent: () => ({ addAgent: mockAddAgent, reset: mockReset }),
}));

vi.mock('../../../hooks/useCreateMcp', () => ({
  useAvailableAgents: () => ({ agents: [], refresh: mockRefresh }),
}));

// The success screen pulls in a lot of presentational deps we don't need here;
// stub it so the test stays focused on the onExit contract.
vi.mock('../AddSuccessScreen', () => ({
  AddSuccessScreen: () => null,
}));

const { AddFlow } = await import('../AddFlow');

function delay(ms = 200) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('AddFlow — non-interactive agent success (#671)', () => {
  beforeEach(() => {
    mockAddAgent.mockReset();
    mockReset.mockReset();
    mockRefresh.mockReset();
    mockAddAgent.mockResolvedValue({
      ok: true,
      type: 'create',
      agentName: 'TestAgent',
      projectName: 'TestProj',
      projectPath: '/tmp/TestProj/app/TestAgent',
    });
  });

  it('passes an exit summary to onExit so the caller can print a confirmation', async () => {
    const onExit = vi.fn();
    render(<AddFlow isInteractive={false} initialResource="agent" onExit={onExit} />);

    await delay();

    expect(mockAddAgent, 'addAgent should be invoked once').toHaveBeenCalledTimes(1);
    expect(onExit, 'onExit should fire after success').toHaveBeenCalledTimes(1);
    expect(onExit.mock.calls[0]?.[0]).toEqual({
      kind: 'create',
      agentName: 'TestAgent',
      projectName: 'TestProj',
      projectPath: '/tmp/TestProj/app/TestAgent',
    });
  });

  it('uses kind "byo" and omits projectPath for bring-your-own agents', async () => {
    mockAddAgent.mockResolvedValue({
      ok: true,
      type: 'byo',
      agentName: 'ByoAgent',
      projectName: 'TestProj',
    });
    const onExit = vi.fn();
    render(<AddFlow isInteractive={false} initialResource="agent" onExit={onExit} />);

    await delay();

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit.mock.calls[0]?.[0]).toEqual({
      kind: 'byo',
      agentName: 'ByoAgent',
      projectName: 'TestProj',
      projectPath: undefined,
    });
  });
});
