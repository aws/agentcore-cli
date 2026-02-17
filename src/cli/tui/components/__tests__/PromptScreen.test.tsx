import { ConfirmPrompt, ErrorPrompt, PromptScreen, SuccessPrompt } from '../PromptScreen.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PromptScreen', () => {
  it('renders children and help text', () => {
    const { lastFrame } = render(
      <PromptScreen helpText="Press Enter">
        <Text>Hello</Text>
      </PromptScreen>
    );

    expect(lastFrame()).toContain('Hello');
    expect(lastFrame()).toContain('Press Enter');
  });

  it('calls onConfirm on Enter key', () => {
    const onConfirm = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onConfirm={onConfirm}>
        <Text>msg</Text>
      </PromptScreen>
    );

    stdin.write(ENTER);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm on y key', () => {
    const onConfirm = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onConfirm={onConfirm}>
        <Text>msg</Text>
      </PromptScreen>
    );

    stdin.write('y');

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on Escape key', () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onExit={onExit}>
        <Text>msg</Text>
      </PromptScreen>
    );

    stdin.write(ESCAPE);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on n key', () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onExit={onExit}>
        <Text>msg</Text>
      </PromptScreen>
    );

    stdin.write('n');

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onBack on b key', () => {
    const onBack = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onBack={onBack}>
        <Text>msg</Text>
      </PromptScreen>
    );

    stdin.write('b');

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores input when inputEnabled is false', () => {
    const onConfirm = vi.fn();
    const onExit = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onConfirm={onConfirm} onExit={onExit} inputEnabled={false}>
        <Text>msg</Text>
      </PromptScreen>
    );

    stdin.write(ENTER);
    stdin.write(ESCAPE);
    stdin.write('y');
    stdin.write('n');

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not call absent callbacks', () => {
    // PromptScreen with no onConfirm/onExit/onBack should not throw
    const { stdin } = render(
      <PromptScreen helpText="help">
        <Text>msg</Text>
      </PromptScreen>
    );

    // These should not throw
    stdin.write(ENTER);
    stdin.write(ESCAPE);
    stdin.write('b');
  });
});

describe('SuccessPrompt', () => {
  it('renders success message', () => {
    const { lastFrame } = render(<SuccessPrompt message="Deployment complete" />);

    expect(lastFrame()).toContain('Deployment complete');
  });

  it('renders detail text when provided', () => {
    const { lastFrame } = render(<SuccessPrompt message="Done" detail="3 agents deployed" />);

    expect(lastFrame()).toContain('3 agents deployed');
  });

  it('shows continue/exit help text when onConfirm provided', () => {
    const { lastFrame } = render(<SuccessPrompt message="Done" onConfirm={vi.fn()} onExit={vi.fn()} />);
    const frame = lastFrame()!;

    expect(frame).toContain('continue');
    expect(frame).toContain('exit');
  });

  it('shows any key help text when no onConfirm', () => {
    const { lastFrame } = render(<SuccessPrompt message="Done" onExit={vi.fn()} />);

    expect(lastFrame()).toContain('any key');
  });

  it('uses custom confirmText and exitText', () => {
    const { lastFrame } = render(
      <SuccessPrompt message="Done" onConfirm={vi.fn()} confirmText="Deploy" exitText="Cancel" />
    );
    const frame = lastFrame()!.toLowerCase();

    expect(frame).toContain('deploy');
    expect(frame).toContain('cancel');
  });
});

describe('ErrorPrompt', () => {
  it('renders error message with cross mark', () => {
    const { lastFrame } = render(<ErrorPrompt message="Something failed" />);
    const frame = lastFrame()!;

    expect(frame).toContain('✗');
    expect(frame).toContain('Something failed');
  });

  it('renders detail text when provided', () => {
    const { lastFrame } = render(<ErrorPrompt message="Failed" detail="Stack rollback" />);

    expect(lastFrame()).toContain('Stack rollback');
  });

  it('shows back and exit help text', () => {
    const { lastFrame } = render(<ErrorPrompt message="Failed" onBack={vi.fn()} onExit={vi.fn()} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Enter/B to go back');
    expect(frame).toContain('Esc/Q to exit');
  });

  it('calls onBack on Enter key', () => {
    const onBack = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onBack={onBack} />);

    stdin.write(ENTER);

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack on b key', () => {
    const onBack = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onBack={onBack} />);

    stdin.write('b');

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on Escape key', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onExit={onExit} />);

    stdin.write(ESCAPE);

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on n key', () => {
    const onExit = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onExit={onExit} />);

    stdin.write('n');

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmPrompt', () => {
  it('renders confirmation message', () => {
    const { lastFrame } = render(<ConfirmPrompt message="Delete agent?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('Delete agent?');
  });

  it('renders detail when provided', () => {
    const { lastFrame } = render(
      <ConfirmPrompt message="Delete?" detail="This is irreversible" onConfirm={vi.fn()} onCancel={vi.fn()} />
    );

    expect(lastFrame()).toContain('This is irreversible');
  });

  it('shows keyboard help when showInput is false', () => {
    const { lastFrame } = render(<ConfirmPrompt message="Delete?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Enter/Y confirm');
    expect(frame).toContain('Esc/N cancel');
  });

  it('shows input help when showInput is true', () => {
    const { lastFrame } = render(<ConfirmPrompt message="Delete?" showInput onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('Type y/n');
  });

  it('calls onConfirm on Enter key', () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<ConfirmPrompt message="Delete?" onConfirm={onConfirm} onCancel={vi.fn()} />);

    stdin.write(ENTER);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on Escape key', () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ConfirmPrompt message="Delete?" onConfirm={vi.fn()} onCancel={onCancel} />);

    stdin.write(ESCAPE);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm on y key', () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<ConfirmPrompt message="Delete?" onConfirm={onConfirm} onCancel={vi.fn()} />);

    stdin.write('y');

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on n key', () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ConfirmPrompt message="Delete?" onConfirm={vi.fn()} onCancel={onCancel} />);

    stdin.write('n');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
