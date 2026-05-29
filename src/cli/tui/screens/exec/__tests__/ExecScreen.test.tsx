import { ExecScreen } from '../ExecScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock registry (breaks circular dep: Screen → hooks → useCreateMcp → registry → primitives → ConfigIO)
// ---------------------------------------------------------------------------

vi.mock('../../../../primitives/registry', () => ({
  credentialPrimitive: {},
  ALL_PRIMITIVES: [],
}));

// ---------------------------------------------------------------------------
// Mock ConfigIO
// ---------------------------------------------------------------------------

const { mockReadProjectSpec, mockReadDeployedState } = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockReadDeployedState: vi.fn(),
}));

vi.mock('../../../../../lib', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    readDeployedState = mockReadDeployedState;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = () => undefined;

/** Flush the useEffect async load. */
const flush = () => new Promise<void>(r => setTimeout(r, 50));

function makeDeployedState(runtimes: Record<string, { runtimeArn?: string }>) {
  return {
    targets: {
      default: {
        resources: { runtimes },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecScreen', () => {
  afterEach(() => vi.clearAllMocks());

  it('auto-selects the single agent without showing the picker', async () => {
    mockReadProjectSpec.mockResolvedValue({ runtimes: [{ name: 'MyAgent' }] });
    mockReadDeployedState.mockResolvedValue(
      makeDeployedState({ MyAgent: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r1' } })
    );

    const onSelect = vi.fn();
    render(<ExecScreen onSelect={onSelect} onExit={noop} />);
    await flush();

    expect(onSelect).toHaveBeenCalledWith({
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r1',
      autoSelected: true,
    });
  });

  it('shows an error when there are no deployed targets', async () => {
    mockReadProjectSpec.mockResolvedValue({ runtimes: [{ name: 'MyAgent' }] });
    mockReadDeployedState.mockResolvedValue({ targets: {} });

    const { lastFrame } = render(<ExecScreen onSelect={noop} onExit={noop} />);
    await flush();

    expect(lastFrame()).toMatch(/no deployed targets/i);
    expect(lastFrame()).toMatch(/agentcore deploy/i);
  });

  it('shows an error when targets exist but no runtime has a runtimeArn', async () => {
    mockReadProjectSpec.mockResolvedValue({ runtimes: [{ name: 'MyAgent' }] });
    mockReadDeployedState.mockResolvedValue(
      makeDeployedState({ MyAgent: {} }) // no runtimeArn
    );

    const { lastFrame } = render(<ExecScreen onSelect={noop} onExit={noop} />);
    await flush();

    expect(lastFrame()).toMatch(/no deployed agents/i);
    expect(lastFrame()).toMatch(/agentcore deploy/i);
  });

  it('calls onSelect with the highlighted agent runtimeArn when Enter is pressed', async () => {
    mockReadProjectSpec.mockResolvedValue({
      runtimes: [{ name: 'AgentA' }, { name: 'AgentB' }],
    });
    mockReadDeployedState.mockResolvedValue(
      makeDeployedState({
        AgentA: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/a' },
        AgentB: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/b' },
      })
    );

    const onSelect = vi.fn();
    const { stdin } = render(<ExecScreen onSelect={onSelect} onExit={noop} />);
    await flush();

    // First item is selected by default — press Enter to confirm
    stdin.write('\r');

    expect(onSelect).toHaveBeenCalledWith({
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/a',
    });
  });
});
