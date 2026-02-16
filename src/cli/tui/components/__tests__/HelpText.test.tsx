import { ExitHelpText, HelpText } from '../HelpText.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('HelpText', () => {
  it('renders text', () => {
    const { lastFrame } = render(<HelpText text="Press Enter to continue" />);

    expect(lastFrame()).toContain('Press Enter to continue');
  });
});

describe('ExitHelpText', () => {
  it('renders exit instructions', () => {
    const { lastFrame } = render(<ExitHelpText />);

    expect(lastFrame()).toContain('Press ESC or Ctrl+Q to exit');
  });
});
