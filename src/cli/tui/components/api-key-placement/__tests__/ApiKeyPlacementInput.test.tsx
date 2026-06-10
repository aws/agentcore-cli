import { ApiKeyPlacementInput } from '../ApiKeyPlacementInput';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const DOWN_ARROW = '\x1B[B';
const ENTER = '\r';
const SPACE = ' ';

const tick = () => new Promise(r => setTimeout(r, 20));

describe('ApiKeyPlacementInput', () => {
  it('renders the placement checklist with default labels', () => {
    const { lastFrame } = render(<ApiKeyPlacementInput onComplete={vi.fn()} onBack={vi.fn()} />);
    expect(lastFrame()).toContain('Location (default: HEADER)');
    expect(lastFrame()).toContain('Parameter name (default: x-api-key)');
  });

  it('completes with undefined placement when nothing is selected (skip path)', async () => {
    const onComplete = vi.fn();
    const { stdin } = render(<ApiKeyPlacementInput onComplete={onComplete} onBack={vi.fn()} />);
    await tick();
    stdin.write(ENTER); // Enter with no selection
    await tick();
    expect(onComplete).toHaveBeenCalledWith(undefined);
  });

  it('builds a placement block with a custom prefix', async () => {
    const onComplete = vi.fn();
    const { stdin } = render(<ApiKeyPlacementInput onComplete={onComplete} onBack={vi.fn()} />);
    await tick();
    stdin.write(DOWN_ARROW); // cursor: location -> parameterName
    await tick();
    stdin.write(DOWN_ARROW); // cursor: parameterName -> prefix
    await tick();
    stdin.write(SPACE); // toggle 'prefix' on
    await tick();
    stdin.write(ENTER); // confirm checklist -> enter prefix sub-step
    await tick();
    stdin.write('Bearer'); // type the prefix value
    await tick();
    stdin.write(ENTER); // submit TextInput
    await tick();
    expect(onComplete).toHaveBeenCalledWith({ prefix: 'Bearer' });
  });
});
