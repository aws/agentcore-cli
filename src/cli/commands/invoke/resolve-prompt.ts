import { readFile } from 'node:fs/promises';

export interface PromptSources {
  /** Value from --prompt flag */
  flag?: string;
  /** Value from positional argument */
  positional?: string;
  /** Path from --prompt-file flag */
  file?: string;
  /** True when stdin is piped (not a TTY) */
  stdinPiped: boolean;
}

export interface ResolvedPrompt {
  success: boolean;
  prompt?: string;
  error?: string;
}

async function readPromptFile(path: string): Promise<ResolvedPrompt> {
  try {
    const content = await readFile(path, 'utf-8');
    return { success: true, prompt: content.replace(/\r?\n$/, '') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to read --prompt-file '${path}': ${message}` };
  }
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Resolves the effective prompt from multiple possible sources.
 *
 * Precedence (hybrid — backward compatible with existing --prompt/positional behavior):
 *   1. --prompt flag
 *   2. positional argument
 *   3. --prompt-file
 *   4. stdin (when piped)
 *
 * Collision rule: --prompt-file AND piped stdin together is an error, since silent
 * precedence between two "bulk" sources would mask user mistakes (e.g. a CI pipeline
 * accidentally piping data while also passing --prompt-file).
 */
export async function resolvePrompt(
  sources: PromptSources,
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<ResolvedPrompt> {
  if (sources.flag !== undefined) return { success: true, prompt: sources.flag };
  if (sources.positional !== undefined) return { success: true, prompt: sources.positional };

  const stdinContent = sources.stdinPiped ? await readStdin(stdin) : '';
  const hasStdinContent = stdinContent.length > 0;

  if (sources.file !== undefined && hasStdinContent) {
    return {
      success: false,
      error: 'Cannot combine --prompt-file with piped stdin. Provide only one prompt source.',
    };
  }
  if (sources.file !== undefined) return readPromptFile(sources.file);
  if (hasStdinContent) return { success: true, prompt: stdinContent };
  return { success: true, prompt: undefined };
}
