import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Preview feature flag', () => {
  test('isPreviewEnabled returns false when __PREVIEW__ is false', async () => {
    const { isPreviewEnabled } = await import('../feature-flags');
    expect(isPreviewEnabled()).toBe(false);
  });

  describe('dead code elimination', () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'preview-flag-test-'));
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    test('GA build contains no harness code', () => {
      const outfile = join(tempDir, 'ga-bundle.mjs');
      execSync(`node esbuild.config.mjs`, {
        cwd: process.cwd(),
        env: { ...process.env, BUILD_PREVIEW: undefined, ESBUILD_OUTFILE: outfile },
        stdio: 'pipe',
      });
      const bundle = readFileSync(outfile, 'utf-8');
      // harness-deployer is a standalone module that should be fully eliminated
      expect(bundle).not.toContain('harness-deployer');
      // imperativeManager is only instantiated inside isPreviewEnabled() guards
      expect(bundle).not.toContain('imperativeManager');
    });

    test('Preview build contains harness code', () => {
      const outfile = join(tempDir, 'preview-bundle.mjs');
      execSync(`node esbuild.config.mjs`, {
        cwd: process.cwd(),
        env: { ...process.env, BUILD_PREVIEW: '1', ESBUILD_OUTFILE: outfile },
        stdio: 'pipe',
      });
      const bundle = readFileSync(outfile, 'utf-8');
      expect(bundle).toContain('harness');
    });
  });
});
