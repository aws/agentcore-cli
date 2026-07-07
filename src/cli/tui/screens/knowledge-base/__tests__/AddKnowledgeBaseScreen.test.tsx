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
};

afterEach(() => vi.restoreAllMocks());

// Helper: walk through name → description → s3 → one URI → done.
// Stops on the confirm step.
async function walkToConfirmStep(stdin: ReturnType<typeof render>['stdin'], kbName = 'tui-kb') {
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

describe('AddKnowledgeBaseScreen — confirm step', () => {
  it('done navigates directly to confirm showing name and data sources', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToConfirmStep(stdin);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Name:');
    expect(frame).toContain('tui-kb');
    expect(frame).toContain('Data Sources');
    expect(frame).toContain('s3://my-bucket/docs/');
  });

  it('full flow submit emits correct config', async () => {
    const onComplete = vi.fn<(config: AddKnowledgeBaseConfig) => void>();
    const { stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} onComplete={onComplete} />);
    await walkToConfirmStep(stdin, 'tui-kb');

    // Confirm
    stdin.write(ENTER);
    await delay();

    expect(onComplete).toHaveBeenCalledTimes(1);
    const cfg = onComplete.mock.calls[0]![0];
    expect(cfg.name).toBe('tui-kb');
    expect(cfg.dataSources).toHaveLength(1);
    expect(cfg.dataSources[0]!.dataSourceType).toBe('s3');
    expect(cfg.dataSources[0]!.value).toBe('s3://my-bucket/docs/');
  });

  it('Esc from confirm returns to add-another step', async () => {
    const { lastFrame, stdin } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await walkToConfirmStep(stdin);

    stdin.write(ESCAPE);
    await delay();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Add another data source');
  });
});

describe('AddKnowledgeBaseScreen — step indicator', () => {
  it('shows Confirm label in the step list', async () => {
    const { lastFrame } = render(<AddKnowledgeBaseScreen {...BASE_PROPS} />);
    await delay();
    expect(lastFrame() ?? '').toContain('Confirm');
  });
});
// Suppress unused imports from helper — keep references silent
void UP_ARROW;
