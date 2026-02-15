import { getEnvPath, getEnvVar, readEnvFile, setEnvVar, writeEnvFile } from '../env.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('getEnvPath', () => {
  it('joins configRoot with .env.local', () => {
    const result = getEnvPath('/some/root');
    expect(result).toBe('/some/root/.env.local');
  });

  it('throws when no configRoot and no project found', () => {
    // With no configRoot, it calls findConfigRoot() which may fail
    // In a tmpdir with no agentcore/ directory, it should throw
    const isolated = mkdtempSync(join(tmpdir(), 'env-test-noroot-'));
    const origCwd = process.cwd();
    const origInitCwd = process.env.INIT_CWD;
    try {
      process.chdir(isolated);
      delete process.env.INIT_CWD;
      expect(() => getEnvPath()).toThrow();
    } finally {
      process.chdir(origCwd);
      if (origInitCwd !== undefined) process.env.INIT_CWD = origInitCwd;
      else delete process.env.INIT_CWD;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe('readEnvFile + writeEnvFile', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'env-test-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty record when .env.local does not exist', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'env-test-empty-'));
    try {
      const result = await readEnvFile(emptyRoot);
      expect(result).toEqual({});
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('reads existing .env.local file', async () => {
    writeFileSync(join(root, '.env.local'), 'MY_KEY="my_value"\nANOTHER="val2"\n');
    const result = await readEnvFile(root);
    expect(result.MY_KEY).toBe('my_value');
    expect(result.ANOTHER).toBe('val2');
  });

  it('writes env file and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-write-'));
    try {
      await writeEnvFile({ FOO: 'bar', BAZ: 'qux' }, dir, false);
      const result = await readEnvFile(dir);
      expect(result.FOO).toBe('bar');
      expect(result.BAZ).toBe('qux');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges with existing values by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-merge-'));
    try {
      await writeEnvFile({ EXISTING: 'old' }, dir, false);
      await writeEnvFile({ NEW_KEY: 'new' }, dir); // merge = true by default
      const result = await readEnvFile(dir);
      expect(result.EXISTING).toBe('old');
      expect(result.NEW_KEY).toBe('new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites when merge is false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-overwrite-'));
    try {
      await writeEnvFile({ OLD: 'value' }, dir, false);
      await writeEnvFile({ NEW: 'value' }, dir, false);
      const result = await readEnvFile(dir);
      expect(result.NEW).toBe('value');
      expect(result.OLD).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escapes special characters in values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-escape-'));
    try {
      await writeEnvFile({ KEY: 'value with "quotes" and \\ backslash' }, dir, false);
      const raw = readFileSync(join(dir, '.env.local'), 'utf-8');
      expect(raw).toContain('\\\\'); // escaped backslash
      expect(raw).toContain('\\"'); // escaped quote
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for invalid env key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-invalid-'));
    try {
      await expect(writeEnvFile({ 'invalid-key': 'value' }, dir, false)).rejects.toThrow('Invalid env key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips null and undefined values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-nulls-'));
    try {
      await writeEnvFile(
        {
          KEEP: 'value',
          SKIP_NULL: null as unknown as string,
          SKIP_UNDEF: undefined as unknown as string,
        },
        dir,
        false
      );
      const result = await readEnvFile(dir);
      expect(result.KEEP).toBe('value');
      expect(result.SKIP_NULL).toBeUndefined();
      expect(result.SKIP_UNDEF).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escapes newlines and carriage returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-newlines-'));
    try {
      await writeEnvFile({ KEY: 'line1\nline2\rline3' }, dir, false);
      const raw = readFileSync(join(dir, '.env.local'), 'utf-8');
      expect(raw).toContain('\\n');
      expect(raw).toContain('\\r');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getEnvVar', () => {
  it('returns a specific env var value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-getvar-'));
    try {
      writeFileSync(join(dir, '.env.local'), 'TARGET="found"\n');
      const result = await getEnvVar('TARGET', dir);
      expect(result).toBe('found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for missing key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-missing-'));
    try {
      writeFileSync(join(dir, '.env.local'), 'OTHER="val"\n');
      const result = await getEnvVar('MISSING', dir);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setEnvVar', () => {
  it('sets a single env var', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-setvar-'));
    try {
      await setEnvVar('SINGLE', 'value', dir);
      const result = await readEnvFile(dir);
      expect(result.SINGLE).toBe('value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
