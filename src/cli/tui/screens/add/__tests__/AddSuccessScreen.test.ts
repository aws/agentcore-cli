import { getAddSuccessSteps } from '../AddSuccessScreen';
import { describe, expect, it } from 'vitest';

describe('getAddSuccessSteps', () => {
  it('returns dev option first when showDevOption is true', () => {
    const steps = getAddSuccessSteps(true);

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ command: 'dev', label: 'Run agent locally' });
    expect(steps[1]).toEqual({ command: 'deploy', label: 'Deploy to AWS' });
    expect(steps[2]).toEqual({ command: 'add', label: 'Add another resource' });
  });

  it('does not include dev option when showDevOption is false', () => {
    const steps = getAddSuccessSteps(false);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ command: 'deploy', label: 'Deploy to AWS' });
    expect(steps[1]).toEqual({ command: 'add', label: 'Add another resource' });
  });

  it('dev option is first (recommended) when shown', () => {
    const steps = getAddSuccessSteps(true);

    // Per issue #152: "The recommended flow is for customers to dev first"
    expect(steps[0]?.command).toBe('dev');
  });
});
