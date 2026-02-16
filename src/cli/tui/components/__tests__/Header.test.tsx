import { Header } from '../Header.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('Header', () => {
  it('renders title', () => {
    const { lastFrame } = render(<Header title="AgentCore" />);

    expect(lastFrame()).toContain('AgentCore');
  });

  it('renders subtitle when provided', () => {
    const { lastFrame } = render(<Header title="AgentCore" subtitle="CLI for AI agents" />);

    expect(lastFrame()).toContain('AgentCore');
    expect(lastFrame()).toContain('CLI for AI agents');
  });

  it('renders version when provided', () => {
    const { lastFrame } = render(<Header title="AgentCore" version="1.2.3" />);

    expect(lastFrame()).toContain('AgentCore');
    expect(lastFrame()).toContain('1.2.3');
  });

  it('renders all props', () => {
    const { lastFrame } = render(<Header title="AgentCore" subtitle="CLI" version="0.1.0" />);

    expect(lastFrame()).toContain('AgentCore');
    expect(lastFrame()).toContain('CLI');
    expect(lastFrame()).toContain('0.1.0');
  });
});
