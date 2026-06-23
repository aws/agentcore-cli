import { resolveEncryptionKey } from '../key-provider';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('resolveEncryptionKey (keyfile fallback)', () => {
  let dir: string;
  const prev = { cfg: process.env.AGENTCORE_CONFIG_DIR, noKc: process.env.AGENTCORE_DISABLE_KEYCHAIN };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentcore-key-'));
    process.env.AGENTCORE_CONFIG_DIR = dir;
    process.env.AGENTCORE_DISABLE_KEYCHAIN = '1';
    const { __resetKeyCacheForTests } = await import('../key-provider');
    __resetKeyCacheForTests();
  });
  afterEach(() => {
    process.env.AGENTCORE_CONFIG_DIR = prev.cfg;
    process.env.AGENTCORE_DISABLE_KEYCHAIN = prev.noKc;
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a 32-byte 0600 keyfile and returns the key', async () => {
    const key = await resolveEncryptionKey();
    expect(key).toHaveLength(32);
    const keyfile = join(dir, 'secrets.key');
    expect(existsSync(keyfile)).toBe(true);
    // 0600 => mode & 0o777 === 0o600 (skip exact check on Windows)
    if (process.platform !== 'win32') {
      expect(statSync(keyfile).mode & 0o777).toBe(0o600);
    }
  });

  it('returns a stable key across calls', async () => {
    const a = await resolveEncryptionKey();
    const b = await resolveEncryptionKey();
    expect(Buffer.compare(a, b)).toBe(0);
  });
});
