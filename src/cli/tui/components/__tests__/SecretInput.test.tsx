import { ApiKeySecretInput, SecretInput } from '../SecretInput.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ENTER = '\r';
const ESCAPE = '\x1B';
const TAB = '\t';

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => vi.restoreAllMocks());

describe('SecretInput', () => {
  it('renders prompt text in bold', () => {
    const { lastFrame } = render(<SecretInput prompt="API Key" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('API Key');
  });

  it('renders description when provided', () => {
    const { lastFrame } = render(
      <SecretInput prompt="Key" description="Enter your key" onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    expect(lastFrame()).toContain('Enter your key');
  });

  it('renders placeholder when value is empty', () => {
    const { lastFrame } = render(
      <SecretInput prompt="Key" placeholder="sk-..." onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    expect(lastFrame()).toContain('sk-...');
  });

  it('masks input with default * character', async () => {
    const { lastFrame, stdin } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await delay();
    stdin.write('secret');
    await delay();

    const frame = lastFrame()!;
    expect(frame).toContain('******');
    expect(frame).not.toContain('secret');
  });

  it('masks input with custom character', async () => {
    const { lastFrame, stdin } = render(
      <SecretInput prompt="Key" maskChar="#" onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('abc');
    await delay();

    expect(lastFrame()).toContain('###');
  });

  it('toggles show/hide on Tab', async () => {
    const { lastFrame, stdin } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await delay();
    stdin.write('mykey');
    await delay();

    // Should be masked initially
    expect(lastFrame()).toContain('*****');
    expect(lastFrame()).not.toContain('mykey');

    // Tab to show
    stdin.write(TAB);
    await delay();

    expect(lastFrame()).toContain('mykey');

    // Tab to hide again
    stdin.write(TAB);
    await delay();

    expect(lastFrame()).toContain('*****');
  });

  it('shows "Tab to show" when masked', () => {
    const { lastFrame } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(lastFrame()).toContain('Tab to show');
  });

  it('shows "Tab to hide" after toggling', async () => {
    const { lastFrame, stdin } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await delay();
    stdin.write(TAB);
    await delay();

    expect(lastFrame()).toContain('Tab to hide');
  });

  it('calls onSubmit with trimmed value on Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<SecretInput prompt="Key" onSubmit={onSubmit} onCancel={vi.fn()} />);

    await delay();
    stdin.write('  mykey  ');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).toHaveBeenCalledWith('mykey');
  });

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={onCancel} />);

    await delay();
    stdin.write(ESCAPE);
    await delay();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onSkip when submitting empty value with onSkip provided', async () => {
    const onSkip = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={onCancel} onSkip={onSkip} />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel when submitting empty value without onSkip', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={onCancel} />);

    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows skip hint when onSkip is provided', () => {
    const { lastFrame } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={vi.fn()} onSkip={vi.fn()} />);

    expect(lastFrame()).toContain('Leave empty to skip');
  });

  it('shows "go back" instead of "cancel" when onSkip is provided', () => {
    const { lastFrame } = render(<SecretInput prompt="Key" onSubmit={vi.fn()} onCancel={vi.fn()} onSkip={vi.fn()} />);

    expect(lastFrame()).toContain('go back');
    expect(lastFrame()).not.toContain('cancel');
  });

  it('does not submit when schema validation fails', async () => {
    const onSubmit = vi.fn();
    const schema = z.string().min(10, 'Too short');
    const { stdin } = render(<SecretInput prompt="Key" schema={schema} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await delay();
    stdin.write('abc');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows validation error after submit attempt', async () => {
    const schema = z.string().min(10, 'Key is too short');
    const { lastFrame, stdin } = render(
      <SecretInput prompt="Key" schema={schema} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('abc');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(lastFrame()).toContain('Key is too short');
  });

  it('shows checkmark when input passes schema validation', async () => {
    const schema = z.string().min(3);
    const { lastFrame, stdin } = render(
      <SecretInput prompt="Key" schema={schema} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('validkey');
    await delay();

    expect(lastFrame()).toContain('\u2713');
  });

  it('shows cross mark when input fails schema validation', async () => {
    const schema = z.string().min(10);
    const { lastFrame, stdin } = render(
      <SecretInput prompt="Key" schema={schema} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('ab');
    await delay();

    expect(lastFrame()).toContain('\u2717');
  });

  it('supports custom validation', async () => {
    const onSubmit = vi.fn();
    const customValidation = (val: string) => (val.startsWith('sk-') ? true : 'Must start with sk-');
    const { lastFrame, stdin } = render(
      <SecretInput prompt="Key" customValidation={customValidation} onSubmit={onSubmit} onCancel={vi.fn()} />
    );

    await delay();
    stdin.write('bad');
    await delay();
    stdin.write(ENTER);
    await delay();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Must start with sk-');
  });

  it('renders partial reveal when revealChars is set', async () => {
    const { lastFrame, stdin } = render(
      <SecretInput prompt="Key" revealChars={2} onSubmit={vi.fn()} onCancel={vi.fn()} />
    );

    await delay();
    // Need value > revealChars * 2 (4) to trigger partial reveal
    stdin.write('abcdefgh');
    await delay();

    const frame = lastFrame()!;
    // With revealChars=2, should show first 2 and last 2 chars with masks in middle
    // "ab****gh" pattern
    expect(frame).toContain('ab');
    expect(frame).toContain('gh');
  });
});

describe('ApiKeySecretInput', () => {
  it('renders provider name in prompt', () => {
    const { lastFrame } = render(
      <ApiKeySecretInput
        providerName="OpenAI"
        envVarName="OPENAI_API_KEY"
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(lastFrame()).toContain('OpenAI API Key');
  });

  it('renders env var name as placeholder', () => {
    const { lastFrame } = render(
      <ApiKeySecretInput
        providerName="OpenAI"
        envVarName="OPENAI_API_KEY"
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Placeholder is displayed when input is empty (slice(1) of placeholder)
    expect(lastFrame()).toContain('PENAI_API_KEY');
  });

  it('renders description about secure storage', () => {
    const { lastFrame } = render(
      <ApiKeySecretInput
        providerName="Anthropic"
        envVarName="ANTHROPIC_API_KEY"
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(lastFrame()).toContain('.env.local');
    expect(lastFrame()).toContain('AgentCore Identity');
  });
});
