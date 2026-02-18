import { type SelectableItem } from '../SelectList.js';
import { SelectScreen } from '../SelectScreen.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ESCAPE = '\x1B';

afterEach(() => vi.restoreAllMocks());

const items: SelectableItem[] = [
  { id: 'a', title: 'Alpha', description: 'First item' },
  { id: 'b', title: 'Beta', description: 'Second item' },
  { id: 'c', title: 'Gamma', description: 'Third item' },
];

describe('SelectScreen', () => {
  it('renders title', () => {
    const { lastFrame } = render(<SelectScreen title="Pick One" items={items} onSelect={vi.fn()} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('Pick One');
  });

  it('renders items', () => {
    const { lastFrame } = render(<SelectScreen title="Test" items={items} onSelect={vi.fn()} onExit={vi.fn()} />);

    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('Beta');
    expect(lastFrame()).toContain('Gamma');
  });

  it('shows emptyMessage when items is empty', () => {
    const { lastFrame } = render(
      <SelectScreen title="Empty" items={[]} onSelect={vi.fn()} onExit={vi.fn()} emptyMessage="Nothing here" />
    );

    expect(lastFrame()).toContain('Nothing here');
  });

  it('calls onExit on Escape', async () => {
    const onExit = vi.fn();
    const { stdin } = render(<SelectScreen title="Test" items={items} onSelect={vi.fn()} onExit={onExit} />);

    await new Promise(resolve => setTimeout(resolve, 50));
    stdin.write(ESCAPE);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onExit).toHaveBeenCalled();
  });

  it('renders children below the list', () => {
    const { lastFrame } = render(
      <SelectScreen title="Test" items={items} onSelect={vi.fn()} onExit={vi.fn()}>
        <Text>Extra footer content</Text>
      </SelectScreen>
    );

    expect(lastFrame()).toContain('Extra footer content');
  });
});
