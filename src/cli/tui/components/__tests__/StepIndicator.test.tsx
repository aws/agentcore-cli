import { StepIndicator } from '../StepIndicator.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockWidth } = vi.hoisted(() => ({ mockWidth: { value: 120 } }));

vi.mock('../../hooks/useResponsive.js', () => ({
  useResponsive: () => ({ width: mockWidth.value, height: 40, isNarrow: mockWidth.value < 60 }),
}));

type Step = 'setup' | 'config' | 'deploy' | 'done';

const steps: Step[] = ['setup', 'config', 'deploy', 'done'];
const labels: Record<Step, string> = {
  setup: 'Setup',
  config: 'Configure',
  deploy: 'Deploy',
  done: 'Done',
};

afterEach(() => {
  mockWidth.value = 120;
});

describe('StepIndicator', () => {
  it('renders all step labels', () => {
    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="setup" labels={labels} />);

    expect(lastFrame()).toContain('Setup');
    expect(lastFrame()).toContain('Configure');
    expect(lastFrame()).toContain('Deploy');
    expect(lastFrame()).toContain('Done');
  });

  it('shows current step indicator', () => {
    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="config" labels={labels} />);

    expect(lastFrame()).toContain('●');
  });

  it('shows completed steps with checkmark', () => {
    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="deploy" labels={labels} />);

    expect(lastFrame()).toContain('✓');
  });

  it('shows pending steps with circle', () => {
    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="setup" labels={labels} />);

    expect(lastFrame()).toContain('○');
  });

  it('shows arrows between steps by default', () => {
    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="setup" labels={labels} />);

    expect(lastFrame()).toContain('→');
  });

  it('hides arrows when showArrows is false', () => {
    const { lastFrame } = render(
      <StepIndicator steps={steps} currentStep="setup" labels={labels} showArrows={false} />
    );

    expect(lastFrame()).not.toContain('→');
  });

  it('wraps steps to multiple rows on narrow screens', () => {
    // Set width narrow enough that all 4 steps can't fit on one row
    mockWidth.value = 30;

    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="setup" labels={labels} />);
    const frame = lastFrame()!;

    // All labels should still be present even if wrapped
    expect(frame).toContain('Setup');
    expect(frame).toContain('Configure');
    expect(frame).toContain('Deploy');
    expect(frame).toContain('Done');

    // On a narrow screen, the frame should have multiple lines of steps
    // (more lines than a wide screen would produce)
    const lines = frame.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('shows all three icon types when step is in the middle', () => {
    const { lastFrame } = render(<StepIndicator steps={steps} currentStep="config" labels={labels} />);
    const frame = lastFrame()!;

    // Should have completed (✓), current (●), and pending (○) icons
    expect(frame).toContain('✓');
    expect(frame).toContain('●');
    expect(frame).toContain('○');
  });
});
