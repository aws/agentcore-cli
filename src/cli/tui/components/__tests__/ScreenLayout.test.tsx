import { ScreenLayout } from '../ScreenLayout.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESCAPE = '\x1B';

afterEach(() => vi.restoreAllMocks());

describe('ScreenLayout', () => {
  it('renders children', () => {
    const { lastFrame } = render(
      <ScreenLayout>
        <Text>Hello Layout</Text>
      </ScreenLayout>
    );

    expect(lastFrame()).toContain('Hello Layout');
  });

  it('calls onExit on Escape when onExit provided', async () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <ScreenLayout onExit={onExit}>
        <Text>Content</Text>
      </ScreenLayout>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not crash on Escape when no onExit', () => {
    const { stdin, lastFrame } = render(
      <ScreenLayout>
        <Text>No Exit Handler</Text>
      </ScreenLayout>
    );

    // Should not throw
    stdin.write(ESCAPE);

    expect(lastFrame()).toContain('No Exit Handler');
  });
});
