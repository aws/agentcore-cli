/**
 * Regression test for the fresh-project first-deploy failure.
 *
 * A freshly-created project has an empty aws-targets.json. The deploy TUI auto-detects the AWS
 * context and saves a default target, but the hook left `selectedTargetIndices` empty. The deploy
 * flow scopes its stack selector to the selected targets (issue #1267), so an empty selection
 * produced a PATTERN_MUST_MATCH selector with zero patterns and the first deploy failed with
 * "Stack selection is ambiguous, please choose a specific stack for import".
 *
 * These tests assert every path that ends in `phase === 'configured'` also selects the target(s)
 * the deploy should be scoped to.
 */
import { useAwsTargetConfig } from '../useAwsTargetConfig';
import { render } from 'ink-testing-library';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindConfigRoot, mockResolveTargets, mockWriteTargets, mockDetectAwsContext } = vi.hoisted(() => ({
  mockFindConfigRoot: vi.fn(),
  mockResolveTargets: vi.fn(),
  mockWriteTargets: vi.fn(),
  mockDetectAwsContext: vi.fn(),
}));

vi.mock('../../../../lib', async () => {
  const actual = await vi.importActual<any>('../../../../lib');
  return {
    ...actual,
    findConfigRoot: mockFindConfigRoot,
    ConfigIO: class {
      resolveAWSDeploymentTargets = mockResolveTargets;
      writeAWSDeploymentTargets = mockWriteTargets;
    },
  };
});

vi.mock('../../../aws', async () => {
  const actual = await vi.importActual<any>('../../../aws');
  return {
    ...actual,
    detectAwsContext: mockDetectAwsContext,
  };
});

function Harness({ onState }: { onState: (state: ReturnType<typeof useAwsTargetConfig>) => void }) {
  const state = useAwsTargetConfig();
  onState(state);
  return null as unknown as React.ReactElement;
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('useAwsTargetConfig target selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindConfigRoot.mockReturnValue('/proj/agentcore');
    mockWriteTargets.mockResolvedValue(undefined);
  });

  it('selects the auto-detected target on a fresh project (empty aws-targets.json)', async () => {
    mockResolveTargets.mockResolvedValue([]);
    mockDetectAwsContext.mockResolvedValue({ accountId: '111111111111', region: 'us-west-2' });

    let latest: any;
    const { unmount } = render(<Harness onState={s => (latest = s)} />);
    await flush();
    unmount();

    expect(latest.phase).toBe('configured');
    expect(mockWriteTargets).toHaveBeenCalledTimes(1);
    // The just-saved default target must be available AND selected — deploy scopes its
    // stack patterns to the selection, so an empty selection deploys nothing and errors.
    expect(latest.availableTargets).toHaveLength(1);
    expect(latest.availableTargets[0].name).toBe('default');
    expect(latest.selectedTargetIndices).toEqual([0]);
  });

  it('selects the lone pre-configured target', async () => {
    const target = { name: 'default', account: '111111111111', region: 'us-west-2' };
    mockResolveTargets.mockResolvedValue([target]);

    let latest: any;
    const { unmount } = render(<Harness onState={s => (latest = s)} />);
    await flush();
    unmount();

    expect(latest.phase).toBe('configured');
    expect(latest.selectedTargetIndices).toEqual([0]);
  });

  it('multi-target projects go to select-target with no implicit selection', async () => {
    mockResolveTargets.mockResolvedValue([
      { name: 'a', account: '111111111111', region: 'us-east-1' },
      { name: 'b', account: '222222222222', region: 'us-west-2' },
    ]);

    let latest: any;
    const { unmount } = render(<Harness onState={s => (latest = s)} />);
    await flush();
    unmount();

    expect(latest.phase).toBe('select-target');
    expect(latest.selectedTargetIndices).toEqual([]);
  });
});
