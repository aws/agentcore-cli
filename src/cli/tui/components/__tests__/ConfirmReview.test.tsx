import { ConfirmReview } from '../ConfirmReview.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('ConfirmReview', () => {
  it('renders default title and help text', () => {
    const { lastFrame } = render(<ConfirmReview fields={[{ label: 'Name', value: 'my-agent' }]} />);
    const frame = lastFrame()!;

    expect(frame).toContain('Review Configuration');
    expect(frame).toContain('Enter confirm');
    expect(frame).toContain('Esc back');
  });

  it('renders custom title', () => {
    const { lastFrame } = render(
      <ConfirmReview title="Review Deploy" fields={[{ label: 'Target', value: 'us-east-1' }]} />
    );

    expect(lastFrame()).toContain('Review Deploy');
    expect(lastFrame()).not.toContain('Review Configuration');
  });

  it('renders each field as label: value on the same line', () => {
    const { lastFrame } = render(
      <ConfirmReview
        fields={[
          { label: 'Name', value: 'my-agent' },
          { label: 'SDK', value: 'Strands' },
          { label: 'Language', value: 'Python' },
        ]}
      />
    );
    const lines = lastFrame()!.split('\n');

    // Each label and its value should appear on the same line
    const nameLine = lines.find(l => l.includes('Name'))!;
    expect(nameLine).toContain('my-agent');

    const sdkLine = lines.find(l => l.includes('SDK'))!;
    expect(sdkLine).toContain('Strands');

    const langLine = lines.find(l => l.includes('Language'))!;
    expect(langLine).toContain('Python');
  });

  it('renders label with colon separator', () => {
    const { lastFrame } = render(<ConfirmReview fields={[{ label: 'Region', value: 'us-east-1' }]} />);
    const lines = lastFrame()!.split('\n');

    const regionLine = lines.find(l => l.includes('Region'))!;
    expect(regionLine).toMatch(/Region.*:.*us-east-1/);
  });

  it('renders custom help text replacing default', () => {
    const { lastFrame } = render(
      <ConfirmReview fields={[{ label: 'Name', value: 'test' }]} helpText="Press Y to confirm" />
    );

    expect(lastFrame()).toContain('Press Y to confirm');
    expect(lastFrame()).not.toContain('Enter confirm');
  });

  it('renders multiple fields in order', () => {
    const { lastFrame } = render(
      <ConfirmReview
        fields={[
          { label: 'First', value: 'A' },
          { label: 'Second', value: 'B' },
          { label: 'Third', value: 'C' },
        ]}
      />
    );
    const frame = lastFrame()!;

    // All three labels should be present
    expect(frame).toContain('First');
    expect(frame).toContain('Second');
    expect(frame).toContain('Third');

    // Verify ordering: First appears before Second
    const firstIdx = frame.indexOf('First');
    const secondIdx = frame.indexOf('Second');
    const thirdIdx = frame.indexOf('Third');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});
