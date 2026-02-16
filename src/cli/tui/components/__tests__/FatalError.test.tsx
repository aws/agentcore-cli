import { FatalError } from '../FatalError.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('FatalError', () => {
  it('renders error message', () => {
    const { lastFrame } = render(<FatalError message="Something went wrong" />);

    expect(lastFrame()).toContain('Something went wrong');
  });

  it('renders detail when provided', () => {
    const { lastFrame } = render(<FatalError message="Error" detail="Check your config file" />);

    expect(lastFrame()).toContain('Error');
    expect(lastFrame()).toContain('Check your config file');
  });

  it('renders suggested command when provided', () => {
    const { lastFrame } = render(<FatalError message="No project found" suggestedCommand="agentcore create" />);

    expect(lastFrame()).toContain('No project found');
    expect(lastFrame()).toContain('agentcore create');
    expect(lastFrame()).toContain('to fix this');
  });

  it('renders all props together', () => {
    const { lastFrame } = render(
      <FatalError message="Deploy failed" detail="Stack is in ROLLBACK state" suggestedCommand="agentcore status" />
    );

    expect(lastFrame()).toContain('Deploy failed');
    expect(lastFrame()).toContain('Stack is in ROLLBACK state');
    expect(lastFrame()).toContain('agentcore status');
  });

  it('does not render detail when not provided', () => {
    const { lastFrame } = render(<FatalError message="Error" />);
    const frame = lastFrame()!;

    expect(frame).toContain('Error');
    expect(frame).not.toContain('to fix this');
  });
});
