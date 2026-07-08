import { BUILD_CONTEXT_DOCKERIGNORE_TEMPLATE, ensureBuildContextDockerignore } from '../build-context-dockerignore.js';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('ensureBuildContextDockerignore', () => {
  const created: string[] = [];
  afterEach(() => {
    created.length = 0;
  });

  it('creates a .dockerignore with secret exclusions when none exists', () => {
    const ctx = mkdtempSync(join(tmpdir(), 'bctx-'));
    const result = ensureBuildContextDockerignore(ctx);

    expect(result).toBe(join(ctx, '.dockerignore'));
    expect(existsSync(join(ctx, '.dockerignore'))).toBe(true);
    const contents = readFileSync(join(ctx, '.dockerignore'), 'utf-8');
    expect(contents).toBe(BUILD_CONTEXT_DOCKERIGNORE_TEMPLATE);
    // Covers the real secret/junk vectors.
    for (const pattern of ['.env', '.env.*', '.git/', 'agentcore/']) {
      expect(contents).toContain(pattern);
    }
  });

  it('never overwrites an existing .dockerignore (returns null)', () => {
    const ctx = mkdtempSync(join(tmpdir(), 'bctx-'));
    writeFileSync(join(ctx, '.dockerignore'), '# user-owned\ncustom-pattern\n');

    const result = ensureBuildContextDockerignore(ctx);

    expect(result).toBeNull();
    // The user's content is preserved untouched.
    expect(readFileSync(join(ctx, '.dockerignore'), 'utf-8')).toBe('# user-owned\ncustom-pattern\n');
  });
});
