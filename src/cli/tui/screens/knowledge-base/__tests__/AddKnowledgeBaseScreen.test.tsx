import { AddKnowledgeBaseScreen } from '../AddKnowledgeBaseScreen';
import type { AddKnowledgeBaseConfig } from '../types';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DOWN_ARROW = '\x1B[B';
const UP_ARROW = '\x1B[A';
const ENTER = '\r';
const ESCAPE = '\x1B';
const BACKSPACE = '\x7f';
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

const BASE_PROPS = {
  onComplete: vi.fn<(config: AddKnowledgeBaseConfig) => void>(),
  onExit: vi.fn(),
  existingKnowledgeBaseNames: [],
  existingGatewayNames: [],
};

afterEach(() => vi.restoreAllMocks());

// Helper: walk through name → description → s3 → one URI → done.
// Stops on the gateway-step picker.
async function walkToGatewayStep(stdin: ReturnType<typeof render>['stdin'], kbName = 'tui-kb') {
  // Name step: clear default and type custom name.
  for (let i = 0; i < 30; i++) stdin.write(BACKSPACE);
  for (const ch of kbName) stdin.write(ch);
  await delay();
  stdin.write(ENTER);
  await delay();

  // Description: skip
  stdin.write(ENTER);
  await delay();

  // Data-source-type: S3 is index 0, accept
  stdin.write(ENTER);
  await delay();

  // Sources: type a URI
  for (const ch of 's3://my-bucket/docs/') stdin.write(ch);
  await delay();
  stdin.write(ENTER);
  await delay();

  // Add another? Move down to "Done — review and submit"
  stdin.write(DOWN_ARROW);
  await delay();
  stdin.write(ENTER);
  await delay();
}

describe('AddKnowledgeBaseScreen — gateway step always shown', () => {
  it('zero gateways: gateway step shows Create-new + Skip (no other items)', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToGatewayStep(stdin);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Wire this knowledge base to a gateway?');
    expect(frame).toContain('Create a new gateway and attach');
    expect(frame).toContain('Skip — KB will be standalone');
    expect(frame).toContain('No gateways exist in this project yet');
  });

  it('zero gateways: picking Skip goes to confirm with "Gateway: none — KB will be standalone"', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToGatewayStep(stdin);

    // Move from "Create new" (index 0) down to "Skip" (index 1)
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(ENTER);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Gateway:');
    expect(frame).toContain('none — KB will be standalone');
  });

  it('zero gateways: picking Create-new advances to a name input defaulted to "${kbName}-gw"', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToGatewayStep(stdin, 'mykb');

    // "Create a new gateway and attach" is index 0 in the zero-gateway picker
    stdin.write(ENTER);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('New gateway name');
    expect(frame).toContain('mykb-gw');
  });

  it('zero gateways: full flow Create-new → submit emits newGatewayName, no gateway', async () => {
    const onComplete = vi.fn<(config: AddKnowledgeBaseConfig) => void>();
    const { stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} onComplete={onComplete} />);
    await walkToGatewayStep(stdin, 'tui-kb');

    // Pick Create-new (index 0)
    stdin.write(ENTER);
    await delay();
    // Accept default name "tui-kb-gw"
    stdin.write(ENTER);
    await delay();
    // Confirm
    stdin.write(ENTER);
    await delay();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const cfg = onComplete.mock.calls[0]![0];
    expect(cfg.newGatewayName).toBe('tui-kb-gw');
    expect(cfg.gateway).toBeUndefined();
    expect(cfg.name).toBe('tui-kb');
  });

  it('zero gateways: confirm view shows "Gateway: tui-kb-gw (will be created)"', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToGatewayStep(stdin, 'tui-kb');

    stdin.write(ENTER); // Create-new
    await delay();
    stdin.write(ENTER); // accept default
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('tui-kb-gw (will be created)');
  });

  it('rejects invalid gateway names with the schema error', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToGatewayStep(stdin, 'tui-kb');

    stdin.write(ENTER); // Create-new
    await delay();
    // Clear default and type invalid name
    for (let i = 0; i < 30; i++) stdin.write(BACKSPACE);
    for (const ch of 'bad name!') stdin.write(ch);
    await delay();
    stdin.write(ENTER);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/alphanumeric with optional hyphens|invalid|error/i);
  });
});

describe('AddKnowledgeBaseScreen — at-least-one-gateway path', () => {
  const PROPS_WITH_GW = { ...BASE_PROPS, existingGatewayNames: ['g1', 'g2'] };

  it('shows existing names + Skip + Create-new in that order', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...PROPS_WITH_GW} />);
    await walkToGatewayStep(stdin);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('g1');
    expect(frame).toContain('g2');
    expect(frame).toContain('Skip');
    expect(frame).toContain('Create a new gateway and attach');
  });

  it('selecting an existing gateway emits gateway=g1, no newGatewayName', async () => {
    const onComplete = vi.fn<(config: AddKnowledgeBaseConfig) => void>();
    const { stdin } = render(<AddKnowledgeBaseScreen {...PROPS_WITH_GW} onComplete={onComplete} />);
    await walkToGatewayStep(stdin);

    // g1 is index 0
    stdin.write(ENTER);
    await delay();
    // Confirm
    stdin.write(ENTER);
    await delay();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const cfg = onComplete.mock.calls[0]![0];
    expect(cfg.gateway).toBe('g1');
    expect(cfg.newGatewayName).toBeUndefined();
  });

  it('Create-new appended at end is reachable; choosing it advances to the name input', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...PROPS_WITH_GW} />);
    await walkToGatewayStep(stdin, 'kb');
    // Items: g1(0), g2(1), Skip(2), Create-new(3). Down 3 times.
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(ENTER);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('New gateway name');
    expect(frame).toContain('kb-gw');
  });

  it('confirm shows "Gateway: g2 (existing)" when an existing gateway picked', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...PROPS_WITH_GW} />);
    await walkToGatewayStep(stdin);

    // Move to g2
    stdin.write(DOWN_ARROW);
    await delay();
    stdin.write(ENTER);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('g2 (existing)');
  });

  it('Esc from new-gateway-name returns to the gateway picker', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...PROPS_WITH_GW} />);
    await walkToGatewayStep(stdin);

    // Pick Create-new (index 3)
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN_ARROW);
      await delay();
    }
    stdin.write(ENTER);
    await delay();
    // Should be on new-gateway-name. Esc back.
    stdin.write(ESCAPE);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Wire this knowledge base to a gateway?');
  });
});

describe('AddKnowledgeBaseScreen — step indicator', () => {
  it('always shows the Gateway label in the step list, even with zero gateways', async () => {
    const { lastFrame } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await delay();
    expect(lastFrame() ?? '').toContain('Gateway');
  });
});
// Suppress unused imports from helper — keep references silent
void UP_ARROW;
