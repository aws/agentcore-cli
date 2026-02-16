import { WizardMultiSelect, WizardSelect } from '../WizardSelect.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('WizardSelect', () => {
  const items = [
    { id: 'strands', title: 'Strands', description: 'AWS Strands SDK' },
    { id: 'langchain', title: 'LangChain' },
  ];

  it('renders title and items', () => {
    const { lastFrame } = render(<WizardSelect title="Select SDK" items={items} selectedIndex={0} />);

    expect(lastFrame()).toContain('Select SDK');
    expect(lastFrame()).toContain('Strands');
    expect(lastFrame()).toContain('LangChain');
  });

  it('renders description when provided', () => {
    const { lastFrame } = render(
      <WizardSelect title="Pick one" description="Choose your framework" items={items} selectedIndex={0} />
    );

    expect(lastFrame()).toContain('Choose your framework');
  });

  it('does not render description when not provided', () => {
    const { lastFrame } = render(<WizardSelect title="Pick one" items={items} selectedIndex={0} />);

    expect(lastFrame()).toContain('Pick one');
    expect(lastFrame()).toContain('Strands');
  });

  it('passes empty message to SelectList', () => {
    const { lastFrame } = render(<WizardSelect title="Pick one" items={[]} selectedIndex={0} emptyMessage="No SDKs" />);

    expect(lastFrame()).toContain('No SDKs');
  });
});

describe('WizardMultiSelect', () => {
  const items = [
    { id: 'agent-1', title: 'Agent A' },
    { id: 'agent-2', title: 'Agent B' },
  ];

  it('renders title and items', () => {
    const { lastFrame } = render(
      <WizardMultiSelect title="Select agents" items={items} cursorIndex={0} selectedIds={new Set()} />
    );

    expect(lastFrame()).toContain('Select agents');
    expect(lastFrame()).toContain('Agent A');
    expect(lastFrame()).toContain('Agent B');
  });

  it('renders description when provided', () => {
    const { lastFrame } = render(
      <WizardMultiSelect
        title="Agents"
        description="Select which agents"
        items={items}
        cursorIndex={0}
        selectedIds={new Set()}
      />
    );

    expect(lastFrame()).toContain('Select which agents');
  });

  it('shows checked items', () => {
    const { lastFrame } = render(
      <WizardMultiSelect title="Agents" items={items} cursorIndex={0} selectedIds={new Set(['agent-1'])} />
    );

    expect(lastFrame()).toContain('[✓]');
  });

  it('passes empty message', () => {
    const { lastFrame } = render(
      <WizardMultiSelect title="Agents" items={[]} cursorIndex={0} selectedIds={new Set()} emptyMessage="No agents" />
    );

    expect(lastFrame()).toContain('No agents');
  });
});
