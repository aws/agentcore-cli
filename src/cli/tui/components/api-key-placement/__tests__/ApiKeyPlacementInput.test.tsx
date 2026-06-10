import { ApiKeyPlacementInput } from '../ApiKeyPlacementInput';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

describe('ApiKeyPlacementInput', () => {
  it('renders the placement checklist with default labels', () => {
    const { lastFrame } = render(<ApiKeyPlacementInput onComplete={vi.fn()} onBack={vi.fn()} />);
    expect(lastFrame()).toContain('Location');
    expect(lastFrame()).toContain('HEADER');
  });

  it('completes with undefined placement when nothing is selected (skip path)', async () => {
    const onComplete = vi.fn();
    const { stdin } = render(<ApiKeyPlacementInput onComplete={onComplete} onBack={vi.fn()} />);
    await new Promise(r => setTimeout(r, 20));
    stdin.write('\r'); // Enter with no selection
    await new Promise(r => setTimeout(r, 20));
    expect(onComplete).toHaveBeenCalledWith(undefined);
  });
});
