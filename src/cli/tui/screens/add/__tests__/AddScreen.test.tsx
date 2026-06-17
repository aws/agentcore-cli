import { AddScreen } from '../AddScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('AddScreen', () => {
  const originalGate = process.env.ENABLE_GATED_FEATURES;
  beforeEach(() => {
    process.env.ENABLE_GATED_FEATURES = '1';
  });
  afterEach(() => {
    if (originalGate === undefined) delete process.env.ENABLE_GATED_FEATURES;
    else process.env.ENABLE_GATED_FEATURES = originalGate;
  });

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

  it('Web Search option shows Coming soon when ENABLE_GATED_FEATURES is unset', () => {
    delete process.env.ENABLE_GATED_FEATURES;
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(<AddScreen onSelect={onSelect} onExit={onExit} />);

    expect(lastFrame()).toContain('Web Search');
    expect(lastFrame()).toContain('Coming soon');
  });
});
