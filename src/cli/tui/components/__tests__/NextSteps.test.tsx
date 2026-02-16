import { NextSteps } from '../NextSteps.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';
const DOWN_ARROW = '\x1B[B';

afterEach(() => vi.restoreAllMocks());

const singleStep = [{ command: 'deploy', label: 'Deploy your agent' }];
const multipleSteps = [
  { command: 'deploy', label: 'Deploy your agent' },
  { command: 'invoke', label: 'Test your agent' },
];

describe('NextSteps non-interactive', () => {
  it('renders command hint for a single step', () => {
    const { lastFrame } = render(<NextSteps steps={singleStep} isInteractive={false} />);

    expect(lastFrame()).toContain('agentcore deploy');
    expect(lastFrame()).toContain('deploy your agent');
  });

  it('renders all commands for multiple steps', () => {
    const { lastFrame } = render(<NextSteps steps={multipleSteps} isInteractive={false} />);

    expect(lastFrame()).toContain('agentcore deploy');
    expect(lastFrame()).toContain('agentcore invoke');
    expect(lastFrame()).toContain('or');
  });

  it('returns null for empty steps', () => {
    const { lastFrame } = render(<NextSteps steps={[]} isInteractive={false} />);

    // null render produces empty frame
    expect(lastFrame()).toBe('');
  });
});

describe('NextSteps interactive', () => {
  it('renders Next steps header and selectable items', () => {
    const { lastFrame } = render(<NextSteps steps={singleStep} isInteractive={true} />);

    expect(lastFrame()).toContain('Next steps:');
    expect(lastFrame()).toContain('deploy');
    expect(lastFrame()).toContain('return');
  });

  it('includes return to main menu option', () => {
    const { lastFrame } = render(<NextSteps steps={singleStep} isInteractive={true} />);

    expect(lastFrame()).toContain('Return to main menu');
  });

  it('calls onSelect with correct step on Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<NextSteps steps={multipleSteps} isInteractive={true} onSelect={onSelect} />);

    // First item is 'deploy', press Enter
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onSelect).toHaveBeenCalledWith({ command: 'deploy', label: 'Deploy your agent' });
  });

  it('calls onSelect with second step after navigating down', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<NextSteps steps={multipleSteps} isInteractive={true} onSelect={onSelect} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onSelect).toHaveBeenCalledWith({ command: 'invoke', label: 'Test your agent' });
  });

  it('calls onBack when return option is selected', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<NextSteps steps={singleStep} isInteractive={true} onBack={onBack} />);

    // Navigate down past the single step to the "return" option
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(DOWN_ARROW);
    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack on Escape', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<NextSteps steps={singleStep} isInteractive={true} onBack={onBack} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
