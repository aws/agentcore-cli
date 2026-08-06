import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ASSETS_DIR = resolve(__dirname, '..');

const PYTHON_HTTP_ENTRYPOINTS = [
  'python/http/autogen/base/main.py',
  'python/http/googleadk/base/main.py',
  'python/http/langchain_langgraph/base/main.py',
  'python/http/openaiagents/base/main.py',
  'python/http/strands/base/main.py',
];

const TYPESCRIPT_HTTP_ENTRYPOINTS = [
  'typescript/http/strands/base/main.ts',
  'typescript/http/vercelai/base/main.ts',
];

describe('HTTP agent template input validation', () => {
  it.each(PYTHON_HTTP_ENTRYPOINTS)('%s rejects non-string prompts', templatePath => {
    const template = readFileSync(resolve(ASSETS_DIR, templatePath), 'utf8');

    expect(template).toContain('if not isinstance(prompt, str):');
    expect(template).toContain('raise ValueError("prompt must be a string")');
  });

  it.each(TYPESCRIPT_HTTP_ENTRYPOINTS)('%s validates prompts with Zod', templatePath => {
    const template = readFileSync(resolve(ASSETS_DIR, templatePath), 'utf8');

    expect(template).toContain("prompt: z.string().default('')");
    expect(template).toContain('requestSchema,');
  });

  it('strips toolUse blocks from the Python Strands message-history tail', () => {
    const template = readFileSync(resolve(ASSETS_DIR, 'python/http/strands/base/main.py'), 'utf8');

    expect(template).toContain('def strip_trailing_tool_use(messages: Any) -> list[dict]:');
    expect(template).toContain('while messages:');
    expect(template).toContain('content = [block for block in original_content if "toolUse" not in block]');
    expect(template).toContain('messages.pop()');
    expect(template).toContain('return strip_trailing_tool_use(payload["messages"])');
  });
});
