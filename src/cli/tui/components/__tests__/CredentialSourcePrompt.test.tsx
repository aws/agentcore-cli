import { CredentialSourcePrompt } from '../CredentialSourcePrompt.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';

afterEach(() => vi.restoreAllMocks());

const defaultProps = {
  missingCredentials: [
    { providerName: 'OpenAI', envVarName: 'OPENAI_API_KEY' },
    { providerName: 'Anthropic', envVarName: 'ANTHROPIC_API_KEY' },
  ],
  onUseEnvLocal: vi.fn(),
  onManualEntry: vi.fn(),
  onSkip: vi.fn(),
};

describe('CredentialSourcePrompt', () => {
  it('renders title', () => {
    const { lastFrame } = render(<CredentialSourcePrompt {...defaultProps} />);

    expect(lastFrame()).toContain('Identity Provider Setup');
  });

  it('renders provider names', () => {
    const { lastFrame } = render(<CredentialSourcePrompt {...defaultProps} />);
    const frame = lastFrame()!;

    expect(frame).toContain('OpenAI');
    expect(frame).toContain('Anthropic');
  });

  it('renders credential count', () => {
    const { lastFrame } = render(<CredentialSourcePrompt {...defaultProps} />);

    expect(lastFrame()).toContain('2 identity providers');
  });

  it('renders singular provider count', () => {
    const { lastFrame } = render(
      <CredentialSourcePrompt
        {...defaultProps}
        missingCredentials={[{ providerName: 'OpenAI', envVarName: 'OPENAI_API_KEY' }]}
      />
    );

    expect(lastFrame()).toContain('1 identity provider configured');
  });

  it('renders source options', () => {
    const { lastFrame } = render(<CredentialSourcePrompt {...defaultProps} />);
    const frame = lastFrame()!;

    expect(frame).toContain('.env.local');
    expect(frame).toContain('Enter credentials manually');
    expect(frame).toContain('Skip for now');
  });

  it('calls onUseEnvLocal when first option selected', () => {
    const onUseEnvLocal = vi.fn();
    const { stdin } = render(<CredentialSourcePrompt {...defaultProps} onUseEnvLocal={onUseEnvLocal} />);

    // First option is already selected
    stdin.write(ENTER);

    expect(onUseEnvLocal).toHaveBeenCalledTimes(1);
  });

  it('renders "Not saved to disk" description for manual entry option', () => {
    const { lastFrame } = render(<CredentialSourcePrompt {...defaultProps} />);

    expect(lastFrame()).toContain('Not saved to disk');
  });

  it('shows navigation help text', () => {
    const { lastFrame } = render(<CredentialSourcePrompt {...defaultProps} />);

    expect(lastFrame()).toContain('navigate');
    expect(lastFrame()).toContain('Enter select');
  });
});
