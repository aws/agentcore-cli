import { type Step, StepProgress, areStepsComplete, hasStepError } from '../StepProgress.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('hasStepError', () => {
  it('returns true when any step has error status', () => {
    const steps: Step[] = [
      { label: 'Build', status: 'success' },
      { label: 'Deploy', status: 'error' },
    ];

    expect(hasStepError(steps)).toBe(true);
  });

  it('returns false when no step has error status', () => {
    const steps: Step[] = [
      { label: 'Build', status: 'success' },
      { label: 'Deploy', status: 'running' },
    ];

    expect(hasStepError(steps)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasStepError([])).toBe(false);
  });
});

describe('areStepsComplete', () => {
  it('returns true when all steps are terminal (success/error/warn/info)', () => {
    const steps: Step[] = [
      { label: 'Build', status: 'success' },
      { label: 'Test', status: 'warn' },
      { label: 'Deploy', status: 'error' },
    ];

    expect(areStepsComplete(steps)).toBe(true);
  });

  it('returns false when a step is still running', () => {
    const steps: Step[] = [
      { label: 'Build', status: 'success' },
      { label: 'Deploy', status: 'running' },
    ];

    expect(areStepsComplete(steps)).toBe(false);
  });

  it('returns false when a step is pending', () => {
    const steps: Step[] = [
      { label: 'Build', status: 'success' },
      { label: 'Deploy', status: 'pending' },
    ];

    expect(areStepsComplete(steps)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(areStepsComplete([])).toBe(false);
  });

  it('returns true when all steps are info', () => {
    const steps: Step[] = [{ label: 'Note', status: 'info' }];

    expect(areStepsComplete(steps)).toBe(true);
  });
});

describe('StepProgress', () => {
  it('renders step labels', () => {
    const steps: Step[] = [
      { label: 'Building project', status: 'success' },
      { label: 'Deploying stack', status: 'pending' },
    ];

    const { lastFrame } = render(<StepProgress steps={steps} />);

    expect(lastFrame()).toContain('Building project');
    expect(lastFrame()).toContain('Deploying stack');
  });

  it('shows [done] on the same line as the success step label', () => {
    const steps: Step[] = [{ label: 'Build', status: 'success' }];

    const { lastFrame } = render(<StepProgress steps={steps} />);
    const lines = lastFrame()!.split('\n');
    const buildLine = lines.find(l => l.includes('Build'))!;

    expect(buildLine).toContain('[done]');
  });

  it('shows [error] on the same line as the error step label', () => {
    const steps: Step[] = [{ label: 'Deploy', status: 'error', error: 'Stack creation failed' }];

    const { lastFrame } = render(<StepProgress steps={steps} />);
    const lines = lastFrame()!.split('\n');
    const deployLine = lines.find(l => l.includes('Deploy'))!;

    expect(deployLine).toContain('[error]');
    // Error message should appear in the output
    expect(lastFrame()).toContain('Stack creation failed');
  });

  it('shows [warning] on the same line as the warn step label', () => {
    const steps: Step[] = [{ label: 'Validate', status: 'warn', warn: 'Deprecated config field' }];

    const { lastFrame } = render(<StepProgress steps={steps} />);
    const lines = lastFrame()!.split('\n');
    const validateLine = lines.find(l => l.includes('Validate'))!;

    expect(validateLine).toContain('[warning]');
    expect(lastFrame()).toContain('Deprecated config field');
  });

  it('shows info message for info steps', () => {
    const steps: Step[] = [{ label: 'Note', status: 'info', info: 'First deploy takes longer' }];

    const { lastFrame } = render(<StepProgress steps={steps} />);

    expect(lastFrame()).toContain('First deploy takes longer');
  });

  it('hides pending steps after an error', () => {
    const steps: Step[] = [
      { label: 'Build', status: 'success' },
      { label: 'Deploy', status: 'error', error: 'Failed' },
      { label: 'Verify', status: 'pending' },
    ];

    const { lastFrame } = render(<StepProgress steps={steps} />);

    expect(lastFrame()).toContain('Build');
    expect(lastFrame()).toContain('Deploy');
    expect(lastFrame()).not.toContain('Verify');
  });
});
