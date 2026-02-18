import { useResponsive } from '../useResponsive.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

function Harness() {
  const { width, height, isNarrow } = useResponsive();
  return (
    <Text>
      width:{width} height:{height} isNarrow:{String(isNarrow)}
    </Text>
  );
}

describe('useResponsive', () => {
  it('returns default dimensions', () => {
    const { lastFrame } = render(<Harness />);

    // ink-testing-library provides no stdout, so defaults apply (100x24)
    expect(lastFrame()).toContain('width:');
    expect(lastFrame()).toContain('height:');
    // Verify numeric values are present
    expect(lastFrame()).toMatch(/width:\d+/);
    expect(lastFrame()).toMatch(/height:\d+/);
  });

  it('isNarrow is false when width >= 80', () => {
    const { lastFrame } = render(<Harness />);

    // Default width is 100, which is >= 80
    expect(lastFrame()).toContain('isNarrow:false');
  });
});
