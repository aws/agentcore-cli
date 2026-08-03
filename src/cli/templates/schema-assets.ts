/**
 * LLM-compacted schema files embedded at build time.
 * Written to agentcore/.llm-context/ during project creation to provide
 * AI coding assistants with compact, readable type definitions.
 *
 * When running from built bundle: text-loader plugin embeds contents.
 * When running from source without the text loader: files are read at runtime.
 */
// @ts-expect-error - text import handled by build plugin
import llmContextReadmeSrc from '../../schema/llm-compacted/README.md';
// @ts-expect-error - text import handled by build plugin
import agentcoreSchemaSrc from '../../schema/llm-compacted/agentcore.ts';
// @ts-expect-error - text import handled by build plugin
import awsTargetsSchemaSrc from '../../schema/llm-compacted/aws-targets.ts';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Get file content - uses imported value if string, otherwise reads from disk.
 */
function getContent(imported: unknown, filename: string): string {
  if (typeof imported === 'string') {
    return imported;
  }
  // Fallback: read from disk when running from source
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const filePath = join(__dirname, '../../schema/llm-compacted', filename);
  return readFileSync(filePath, 'utf-8');
}

/**
 * LLM-compacted schema files for AI coding context.
 * Each file is self-contained and maps to a JSON config file.
 */
export const LLM_CONTEXT_FILES: Record<string, string> = {
  'README.md': getContent(llmContextReadmeSrc, 'README.md'),
  'agentcore.ts': getContent(agentcoreSchemaSrc, 'agentcore.ts'),
  'aws-targets.ts': getContent(awsTargetsSchemaSrc, 'aws-targets.ts'),
};
