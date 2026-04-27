import { resolvePrompt } from '../resolve-prompt';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolvePrompt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), `resolve-prompt-${randomUUID()}-`));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns --prompt flag value when provided', async () => {
    const result = await resolvePrompt({ flag: 'hello', stdinPiped: false });
    expect(result).toEqual({ success: true, prompt: 'hello' });
  });

  it('prefers --prompt flag over positional, file, and stdin', async () => {
    const file = join(dir, 'p.txt');
    await writeFile(file, 'from-file');
    const result = await resolvePrompt(
      { flag: 'from-flag', positional: 'from-positional', file, stdinPiped: true },
      Readable.from(['from-stdin'])
    );
    expect(result).toEqual({ success: true, prompt: 'from-flag' });
  });

  it('prefers --prompt over positional', async () => {
    const result = await resolvePrompt({ flag: 'from-flag', positional: 'from-positional', stdinPiped: false });
    expect(result).toEqual({ success: true, prompt: 'from-flag' });
  });

  it('falls back to positional when no flag', async () => {
    const result = await resolvePrompt({ positional: 'from-positional', stdinPiped: false });
    expect(result).toEqual({ success: true, prompt: 'from-positional' });
  });

  it('reads from --prompt-file when no flag or positional', async () => {
    const file = join(dir, 'p.txt');
    await writeFile(file, 'content from file\n');
    const result = await resolvePrompt({ file, stdinPiped: false });
    expect(result).toEqual({ success: true, prompt: 'content from file' });
  });

  it('strips only one trailing newline from file content', async () => {
    const file = join(dir, 'p.txt');
    await writeFile(file, 'line1\nline2\n\n');
    const result = await resolvePrompt({ file, stdinPiped: false });
    expect(result.prompt).toBe('line1\nline2\n');
  });

  it('reads from stdin when piped and no other source', async () => {
    const result = await resolvePrompt({ stdinPiped: true }, Readable.from(['piped input\n']));
    expect(result).toEqual({ success: true, prompt: 'piped input' });
  });

  it('errors when --prompt-file and stdin are both present', async () => {
    const file = join(dir, 'p.txt');
    await writeFile(file, 'x');
    const result = await resolvePrompt({ file, stdinPiped: true }, Readable.from(['y']));
    expect(result.success).toBe(false);
    expect(result.error).toContain('--prompt-file');
    expect(result.error).toContain('stdin');
  });

  it('returns failure when --prompt-file does not exist', async () => {
    const result = await resolvePrompt({ file: join(dir, 'missing.txt'), stdinPiped: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read --prompt-file');
  });

  it('returns undefined prompt when no source is provided', async () => {
    const result = await resolvePrompt({ stdinPiped: false });
    expect(result).toEqual({ success: true, prompt: undefined });
  });

  it('preserves empty-string flag (does not fall through)', async () => {
    const result = await resolvePrompt({ flag: '', positional: 'ignored', stdinPiped: false });
    expect(result).toEqual({ success: true, prompt: '' });
  });
});
