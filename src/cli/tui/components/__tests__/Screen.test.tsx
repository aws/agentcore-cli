import { Screen } from '../Screen.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESCAPE = '\x1B';

afterEach(() => vi.restoreAllMocks());

describe('Screen', () => {
  it('calls onExit on Escape key', async () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <Screen title="Test" onExit={onExit}>
        <Text>Content</Text>
      </Screen>
    );

    stdin.write(ESCAPE);
    await new Promise(resolve => setImmediate(resolve));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on Ctrl+Q', () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <Screen title="Test" onExit={onExit}>
        <Text>Content</Text>
      </Screen>
    );

    stdin.write('\x11'); // Ctrl+Q

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not call onExit when exitEnabled is false', () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <Screen title="Test" onExit={onExit} exitEnabled={false}>
        <Text>Content</Text>
      </Screen>
    );

    stdin.write(ESCAPE);
    stdin.write('\x11');

    expect(onExit).not.toHaveBeenCalled();
  });
});
