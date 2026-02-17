import { Screen } from '../Screen.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESCAPE = '\x1B';

afterEach(() => vi.restoreAllMocks());

describe('Screen', () => {
  it('renders title in the header', () => {
    const { lastFrame } = render(
      <Screen title="Deploy" onExit={vi.fn()}>
        <Text>Content</Text>
      </Screen>
    );

    expect(lastFrame()).toContain('Deploy');
  });

  it('renders children content', () => {
    const { lastFrame } = render(
      <Screen title="Test" onExit={vi.fn()}>
        <Text>Hello World</Text>
      </Screen>
    );

    expect(lastFrame()).toContain('Hello World');
  });

  it('renders default help text when none provided', () => {
    const { lastFrame } = render(
      <Screen title="Test" onExit={vi.fn()}>
        <Text>Content</Text>
      </Screen>
    );

    expect(lastFrame()).toContain('Esc back');
  });

  it('renders custom help text when provided', () => {
    const { lastFrame } = render(
      <Screen title="Test" onExit={vi.fn()} helpText="Press Enter to continue">
        <Text>Content</Text>
      </Screen>
    );

    expect(lastFrame()).toContain('Press Enter to continue');
  });

  it('calls onExit on Escape key', () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <Screen title="Test" onExit={onExit}>
        <Text>Content</Text>
      </Screen>
    );

    stdin.write(ESCAPE);

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

  it('renders header content when provided', () => {
    const { lastFrame } = render(
      <Screen title="Test" onExit={vi.fn()} headerContent={<Text>Status: Active</Text>}>
        <Text>Content</Text>
      </Screen>
    );

    expect(lastFrame()).toContain('Status: Active');
  });

  it('renders footer content when provided', () => {
    const { lastFrame } = render(
      <Screen title="Test" onExit={vi.fn()} footerContent={<Text>3 items selected</Text>}>
        <Text>Content</Text>
      </Screen>
    );

    expect(lastFrame()).toContain('3 items selected');
  });
});
