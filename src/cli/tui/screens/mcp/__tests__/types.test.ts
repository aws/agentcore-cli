import { AUTHORIZER_TYPE_OPTIONS, ENTER_KB_ID_MANUALLY, SKIP_FOR_NOW, TARGET_TYPE_OPTIONS } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('MCP types constants', () => {
  it('AUTHORIZER_TYPE_OPTIONS: AWS_IAM is first option', () => {
    expect(AUTHORIZER_TYPE_OPTIONS[0]?.id).toBe('AWS_IAM');
  });

  it('SKIP_FOR_NOW equals skip-for-now', () => {
    expect(SKIP_FOR_NOW).toBe('skip-for-now');
  });

  it('TARGET_TYPE_OPTIONS has mcpServer entry', () => {
    const mcpServer = TARGET_TYPE_OPTIONS.find((opt: { id: string }) => opt.id === 'mcpServer');
    expect(mcpServer).toBeDefined();
  });

  it('TARGET_TYPE_OPTIONS exposes a connector (Knowledge Base) entry', () => {
    const connector = TARGET_TYPE_OPTIONS.find((opt: { id: string }) => opt.id === 'connector');
    expect(connector).toBeDefined();
    expect(connector?.title).toBe('Knowledge Base');
  });

  it('ENTER_KB_ID_MANUALLY is a stable sentinel id', () => {
    // Sentinel for the "Enter an existing KB ID manually..." picker entry —
    // the screen branches on this exact id when the user picks the manual path.
    expect(ENTER_KB_ID_MANUALLY).toBe('__enter_kb_id__');
  });
});
