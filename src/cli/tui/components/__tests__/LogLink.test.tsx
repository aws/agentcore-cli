import { LogLink } from '../LogLink.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('LogLink', () => {
  it('renders with prefix and relative path', () => {
    const { lastFrame } = render(<LogLink filePath="/Users/dev/project/logs/deploy.log" />);

    expect(lastFrame()).toContain('Log:');
  });

  it('renders custom display text', () => {
    const { lastFrame } = render(<LogLink filePath="/tmp/test.log" displayText="test.log" />);

    expect(lastFrame()).toContain('test.log');
  });

  it('hides prefix when showPrefix is false', () => {
    const { lastFrame } = render(<LogLink filePath="/tmp/test.log" showPrefix={false} />);

    expect(lastFrame()).not.toContain('Log:');
  });

  it('renders custom label', () => {
    const { lastFrame } = render(<LogLink filePath="/tmp/test.log" label="Output" />);

    expect(lastFrame()).toContain('Output:');
  });
});
