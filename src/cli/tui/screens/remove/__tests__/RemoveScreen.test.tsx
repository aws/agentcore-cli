import { RemoveScreen } from '../RemoveScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

describe('RemoveScreen', () => {
  it('gateway and gateway-target options enabled when counts > 0', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(
      <RemoveScreen
        onSelect={onSelect}
        onExit={onExit}
        agentCount={1}
        gatewayCount={1}
        mcpToolCount={1}
        memoryCount={1}
        identityCount={1}
      />
    );

    expect(lastFrame()).toContain('Gateway');
    expect(lastFrame()).toContain('Gateway Target');
    expect(lastFrame()).not.toContain('No gateways to remove');
    expect(lastFrame()).not.toContain('No gateway targets to remove');
  });

  it('gateway and gateway-target options disabled when counts = 0', () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();

    const { lastFrame } = render(
      <RemoveScreen
        onSelect={onSelect}
        onExit={onExit}
        agentCount={0}
        gatewayCount={0}
        mcpToolCount={0}
        memoryCount={0}
        identityCount={0}
      />
    );

    expect(lastFrame()).toContain('No gateways to remove');
    expect(lastFrame()).toContain('No gateway targets to remove');
  });
});
