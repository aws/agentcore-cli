import { useSchemaDocument } from '../useSchemaDocument.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockLoadSchemaDocument, mockSaveSchemaDocument } = vi.hoisted(() => ({
  mockLoadSchemaDocument: vi.fn(),
  mockSaveSchemaDocument: vi.fn(),
}));

vi.mock('../../../schema/index.js', () => ({
  loadSchemaDocument: mockLoadSchemaDocument,
  saveSchemaDocument: mockSaveSchemaDocument,
}));

const testSchema = z.object({ name: z.string() });

function Harness({ filePath }: { filePath: string }) {
  const { content, status, validationMessage } = useSchemaDocument(filePath, testSchema);
  return (
    <Text>
      status:{status.status} content:{content || 'empty'} validation:{validationMessage ?? 'none'} message:
      {status.status === 'error' ? status.message : 'none'}
    </Text>
  );
}

describe('useSchemaDocument', () => {
  afterEach(() => vi.clearAllMocks());

  it('starts in loading status', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    mockLoadSchemaDocument.mockReturnValue(new Promise(() => {})); // never resolves

    const { lastFrame } = render(<Harness filePath="/test.yaml" />);

    expect(lastFrame()).toContain('status:loading');
  });

  it('loads content and transitions to ready', async () => {
    mockLoadSchemaDocument.mockResolvedValue({
      content: 'name: test',
      validationError: undefined,
    });

    const { lastFrame } = render(<Harness filePath="/test.yaml" />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('status:ready');
    });
    expect(lastFrame()).toContain('content:name: test');
  });

  it('shows error status when load fails', async () => {
    mockLoadSchemaDocument.mockRejectedValue(new Error('File not found'));

    const { lastFrame } = render(<Harness filePath="/missing.yaml" />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('status:error');
    });
    expect(lastFrame()).toContain('message:File not found');
  });

  it('shows validation message from load result', async () => {
    mockLoadSchemaDocument.mockResolvedValue({
      content: 'invalid: true',
      validationError: 'Missing required field: name',
    });

    const { lastFrame } = render(<Harness filePath="/bad.yaml" />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('status:ready');
    });
    expect(lastFrame()).toContain('validation:Missing required field: name');
  });
});
