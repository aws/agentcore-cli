import { AddScreen } from '../AddScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

describe('AddScreen', () => {
  it('gateway and gateway-target options are present and not disabled', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(<AddScreen onSelect={onSelect} onExit={onExit} />);

    expect(lastFrame()).toContain('Gateway');
    expect(lastFrame()).toContain('Gateway Target');
  });

  it('payment manager and connector are separate top-level options', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(<AddScreen onSelect={onSelect} onExit={onExit} />);

    expect(lastFrame()).toContain('Payment Manager');
    expect(lastFrame()).toContain('Payment Connector');
  });
});
