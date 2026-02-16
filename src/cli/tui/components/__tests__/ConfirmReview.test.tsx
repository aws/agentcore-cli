import { ConfirmReview } from '../ConfirmReview.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('ConfirmReview', () => {
  it('renders default title and help text', () => {
    const { lastFrame } = render(<ConfirmReview fields={[{ label: 'Name', value: 'my-agent' }]} />);

    expect(lastFrame()).toContain('Review Configuration');
    expect(lastFrame()).toContain('Enter confirm');
    expect(lastFrame()).toContain('Esc back');
  });

  it('renders custom title', () => {
    const { lastFrame } = render(
      <ConfirmReview title="Review Deploy" fields={[{ label: 'Target', value: 'us-east-1' }]} />
    );

    expect(lastFrame()).toContain('Review Deploy');
  });

  it('renders all fields', () => {
    const { lastFrame } = render(
      <ConfirmReview
        fields={[
          { label: 'Name', value: 'my-agent' },
          { label: 'SDK', value: 'Strands' },
          { label: 'Language', value: 'Python' },
        ]}
      />
    );

    expect(lastFrame()).toContain('Name');
    expect(lastFrame()).toContain('my-agent');
    expect(lastFrame()).toContain('SDK');
    expect(lastFrame()).toContain('Strands');
    expect(lastFrame()).toContain('Language');
    expect(lastFrame()).toContain('Python');
  });

  it('renders custom help text', () => {
    const { lastFrame } = render(
      <ConfirmReview fields={[{ label: 'Name', value: 'test' }]} helpText="Press Y to confirm" />
    );

    expect(lastFrame()).toContain('Press Y to confirm');
    expect(lastFrame()).not.toContain('Enter confirm');
  });
});
