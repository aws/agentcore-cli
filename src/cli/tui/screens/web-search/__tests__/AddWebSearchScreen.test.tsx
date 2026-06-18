import { AddWebSearchScreen } from '../AddWebSearchScreen';
import type { AddWebSearchConfig } from '../types';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';
const BACKSPACE = '\x7f';
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

function makeProps(overrides: Partial<React.ComponentProps<typeof AddWebSearchScreen>> = {}) {
  return {
    onComplete: vi.fn<(config: AddWebSearchConfig) => void>(),
    onExit: vi.fn(),
    existingGatewayNames: [],
    existingToolNames: [],
    ...overrides,
  };
}

// Walk past the name step by accepting the default and pressing Enter.
async function submitName(stdin: ReturnType<typeof render>['stdin']) {
  stdin.write(ENTER);
  await delay();
}

afterEach(() => vi.restoreAllMocks());

describe('AddWebSearchScreen — Escape navigation', () => {
  it('Escape on the no-gateways view calls onExit (the only step where Screen owns Esc)', async () => {
    const props = makeProps({ existingGatewayNames: [] });
    const { lastFrame, stdin } = render(<AddWebSearchScreen {...props} />);

    await submitName(stdin);
    expect(lastFrame() ?? '').toContain('No gateways found');

    stdin.write(ESCAPE);
    await delay();

    expect(props.onExit).toHaveBeenCalledTimes(1);
  });

  it('Escape on the gateway step (with gateways) goes back to name, does NOT call onExit', async () => {
    const props = makeProps({ existingGatewayNames: ['gw1'] });
    const { lastFrame, stdin } = render(<AddWebSearchScreen {...props} />);

    await submitName(stdin);
    expect(lastFrame() ?? '').toContain('Attach to which gateway?');

    stdin.write(ESCAPE);
    await delay();

    expect(props.onExit).not.toHaveBeenCalled();
    // Back at the name step: the name input is mounted again.
    expect(lastFrame() ?? '').toContain('Web search target name');
  });

  it('Escape on the exclude-domains step goes back to gateway, does NOT call onExit', async () => {
    const props = makeProps({ existingGatewayNames: ['gw1'] });
    const { lastFrame, stdin } = render(<AddWebSearchScreen {...props} />);

    await submitName(stdin);
    // Pick gw1 (single item, already selected), advance to exclude-domains.
    stdin.write(ENTER);
    await delay();
    expect(lastFrame() ?? '').toContain('Exclude domains');

    stdin.write(ESCAPE);
    await delay();

    expect(props.onExit).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Attach to which gateway?');
  });

  it('Escape on the confirm step goes back to exclude-domains, does NOT call onExit', async () => {
    const props = makeProps({ existingGatewayNames: ['gw1'] });
    const { lastFrame, stdin } = render(<AddWebSearchScreen {...props} />);

    await submitName(stdin);
    stdin.write(ENTER); // pick gw1
    await delay();
    stdin.write(ENTER); // submit empty exclude-domains, advance to confirm
    await delay();
    expect(lastFrame() ?? '').toContain('Confirm');

    stdin.write(ESCAPE);
    await delay();

    expect(props.onExit).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Exclude domains');
  });

  it('Escape on the name step calls onExit', async () => {
    const props = makeProps({ existingGatewayNames: ['gw1'] });
    const { stdin } = render(<AddWebSearchScreen {...props} />);

    // Clear the default value first so TextInput's onCancel fires onExit
    // rather than just clearing input.
    for (let i = 0; i < 30; i++) stdin.write(BACKSPACE);
    await delay();
    stdin.write(ESCAPE);
    await delay();

    expect(props.onExit).toHaveBeenCalled();
  });
});
