import { ScreenHeader } from '../ScreenHeader.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('ScreenHeader', () => {
  it('renders title', () => {
    const { lastFrame } = render(<ScreenHeader title="Deploy" />);

    expect(lastFrame()).toContain('Deploy');
  });

  it('renders children when provided', () => {
    const { lastFrame } = render(
      <ScreenHeader title="Status">
        <Text>Target: us-east-1</Text>
      </ScreenHeader>
    );

    expect(lastFrame()).toContain('Status');
    expect(lastFrame()).toContain('Target: us-east-1');
  });

  it('does not render children area when no children', () => {
    const { lastFrame } = render(<ScreenHeader title="Help" />);

    expect(lastFrame()).toContain('Help');
  });
});
