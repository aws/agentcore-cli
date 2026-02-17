import { useExitHandler } from '../useExitHandler.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESCAPE = '\x1B';

afterEach(() => vi.restoreAllMocks());

function ExitHandlerHarness({ onExit, enabled }: { onExit: () => void; enabled?: boolean }) {
  useExitHandler(onExit, enabled);
  return <Text>Active</Text>;
}

describe('useExitHandler', () => {
  it('calls onExit when Escape is pressed', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ExitHandlerHarness onExit={onExit} />);

    stdin.write(ESCAPE);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit when Ctrl+Q is pressed', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ExitHandlerHarness onExit={onExit} />);

    stdin.write('\x11'); // Ctrl+Q

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('does not call onExit when enabled is false', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ExitHandlerHarness onExit={onExit} enabled={false} />);

    stdin.write(ESCAPE);
    stdin.write('\x11'); // Ctrl+Q

    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not call onExit on unrelated keys', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ExitHandlerHarness onExit={onExit} />);

    stdin.write('a');
    stdin.write('\r'); // Enter
    stdin.write('\x1B[A'); // Up arrow

    expect(onExit).not.toHaveBeenCalled();
  });

  it('enabled defaults to true', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ExitHandlerHarness onExit={onExit} />);

    stdin.write(ESCAPE);

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
