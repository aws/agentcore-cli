import { useDevDeploy } from '../useDevDeploy.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockHandleDeploy = vi.fn();

vi.mock('../../../commands/deploy/actions.js', () => ({
  handleDeploy: (...args: unknown[]) => mockHandleDeploy(...args),
}));

function Harness({ skip }: { skip?: boolean }) {
  const { steps, isComplete, error } = useDevDeploy({ skip });
  return (
    <Text>
      steps:{steps.length} isComplete:{String(isComplete)} error:{error ?? 'null'}
    </Text>
  );
}

describe('useDevDeploy', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls handleDeploy on mount', async () => {
    mockHandleDeploy.mockResolvedValue({ success: true });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(mockHandleDeploy).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'default',
          autoConfirm: true,
        })
      );
    });

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
    });
  });

  it('does not call handleDeploy when skip is true', async () => {
    const { lastFrame } = render(<Harness skip={true} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
    });

    expect(mockHandleDeploy).not.toHaveBeenCalled();
  });

  it('captures error from failed deploy', async () => {
    mockHandleDeploy.mockResolvedValue({ success: false, error: 'Stack failed' });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
      expect(lastFrame()).toContain('error:Stack failed');
    });
  });

  it('captures error from thrown exception', async () => {
    mockHandleDeploy.mockRejectedValue(new Error('Network error'));

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
      expect(lastFrame()).toContain('error:Network error');
    });
  });

  it('populates steps from onProgress callback', async () => {
    mockHandleDeploy.mockImplementation((opts: { onProgress?: (step: string, status: string) => void }) => {
      opts.onProgress?.('Validate project', 'start');
      opts.onProgress?.('Validate project', 'success');
      opts.onProgress?.('Build CDK', 'start');
      opts.onProgress?.('Build CDK', 'success');
      return Promise.resolve({ success: true });
    });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('steps:2');
      expect(lastFrame()).toContain('isComplete:true');
    });
  });
});
