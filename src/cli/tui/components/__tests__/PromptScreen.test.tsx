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

  it('calls onConfirm on Enter key', async () => {
    const onConfirm = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onConfirm={onConfirm}>
        <Text>msg</Text>
      </PromptScreen>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm on y key', async () => {
    const onConfirm = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onConfirm={onConfirm}>
        <Text>msg</Text>
      </PromptScreen>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('y');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on Escape key', async () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onExit={onExit}>
        <Text>msg</Text>
      </PromptScreen>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on n key', async () => {
    const onExit = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onExit={onExit}>
        <Text>msg</Text>
      </PromptScreen>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('n');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onBack on b key', async () => {
    const onBack = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onBack={onBack}>
        <Text>msg</Text>
      </PromptScreen>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('b');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores input when inputEnabled is false', async () => {
    const onConfirm = vi.fn();
    const onExit = vi.fn();
    const { stdin } = render(
      <PromptScreen helpText="help" onConfirm={onConfirm} onExit={onExit} inputEnabled={false}>
        <Text>msg</Text>
      </PromptScreen>
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
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

  it('shows confirm and exit help text when onConfirm provided', () => {
    const { lastFrame } = render(<SuccessPrompt message="Done" onConfirm={vi.fn()} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('continue');
    expect(lastFrame()).toContain('exit');
  });

  it('shows any key help text when no onConfirm', () => {
    const { lastFrame } = render(<SuccessPrompt message="Done" onExit={vi.fn()} />);

    expect(lastFrame()).toContain('any key');
  });

  it('uses custom confirmText and exitText', () => {
    const { lastFrame } = render(
      <SuccessPrompt message="Done" onConfirm={vi.fn()} confirmText="Deploy" exitText="Cancel" />
    );

    expect(lastFrame()).toContain('deploy');
    expect(lastFrame()).toContain('cancel');
  });
});

describe('ErrorPrompt', () => {
  it('renders error message with cross mark', () => {
    const { lastFrame } = render(<ErrorPrompt message="Something failed" />);

    expect(lastFrame()).toContain('✗');
    expect(lastFrame()).toContain('Something failed');
  });

  it('renders detail text when provided', () => {
    const { lastFrame } = render(<ErrorPrompt message="Failed" detail="Stack rollback" />);

    expect(lastFrame()).toContain('Stack rollback');
  });

  it('shows back and exit help text', () => {
    const { lastFrame } = render(<ErrorPrompt message="Failed" onBack={vi.fn()} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('Enter/B to go back');
    expect(lastFrame()).toContain('Esc/Q to exit');
  });

  it('calls onBack on Enter key', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onBack={onBack} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onBack on b key', async () => {
    const onBack = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onBack={onBack} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('b');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on Escape key', async () => {
    const onExit = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onExit={onExit} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit on n key', async () => {
    const onExit = vi.fn();
    const { stdin } = render(<ErrorPrompt message="Failed" onExit={onExit} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write('n');
    await new Promise(resolve => setTimeout(resolve, 50));

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

    expect(lastFrame()).toContain('Enter/Y confirm');
    expect(lastFrame()).toContain('Esc/N cancel');
  });

  it('shows input help when showInput is true', () => {
    const { lastFrame } = render(<ConfirmPrompt message="Delete?" showInput onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('Type y/n');
  });

  it('calls onConfirm on Enter key (no showInput)', async () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<ConfirmPrompt message="Delete?" onConfirm={onConfirm} onCancel={vi.fn()} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ENTER);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on Escape key', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<ConfirmPrompt message="Delete?" onConfirm={vi.fn()} onCancel={onCancel} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
