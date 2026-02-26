import { AddScreen } from '../AddScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

describe('AddScreen', () => {
  it('gateway and gateway-target options are present and not disabled', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(<AddScreen onSelect={onSelect} onExit={onExit} hasAgents={true} />);

    expect(lastFrame()).toContain('Gateway');
    expect(lastFrame()).toContain('Gateway Target');
    expect(lastFrame()).not.toContain('Add an agent first');
  });
});
