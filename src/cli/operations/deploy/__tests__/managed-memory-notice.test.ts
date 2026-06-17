import type { ConfigIO } from '../../../../lib';
import {
  MANAGED_MEMORY_ADD_NOTICE,
  MANAGED_MEMORY_DEPLOY_NOTICE,
  hasManagedMemoryHarness,
} from '../managed-memory-notice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Builds a stub ConfigIO whose readHarnessSpec returns the given mode per harness name.
 * Unknown names reject (mirrors a missing/unreadable harness.json).
 */
function stubConfigIO(modes: Record<string, string | undefined>): ConfigIO {
  return {
    readHarnessSpec: vi.fn((name: string) => {
      if (!(name in modes)) {
        return Promise.reject(new Error(`no spec for ${name}`));
      }
      const mode = modes[name];
      return Promise.resolve({ memory: mode ? { mode } : undefined } as never);
    }),
  } as unknown as ConfigIO;
}

describe('hasManagedMemoryHarness', () => {
  const originalGate = process.env.ENABLE_GATED_FEATURES;

  beforeEach(() => {
    process.env.ENABLE_GATED_FEATURES = '1';
  });

  afterEach(() => {
    if (originalGate === undefined) {
      delete process.env.ENABLE_GATED_FEATURES;
    } else {
      process.env.ENABLE_GATED_FEATURES = originalGate;
    }
    vi.clearAllMocks();
  });

  it('returns false when the gate is off, even with a managed harness', async () => {
    delete process.env.ENABLE_GATED_FEATURES;
    const configIO = stubConfigIO({ h1: 'managed' });
    expect(await hasManagedMemoryHarness(configIO, [{ name: 'h1' }])).toBe(false);
  });

  it('returns false when there are no harnesses', async () => {
    expect(await hasManagedMemoryHarness(stubConfigIO({}), [])).toBe(false);
    expect(await hasManagedMemoryHarness(stubConfigIO({}), undefined)).toBe(false);
  });

  it('returns true when any harness uses managed memory', async () => {
    const configIO = stubConfigIO({ h1: 'existing', h2: 'managed' });
    expect(await hasManagedMemoryHarness(configIO, [{ name: 'h1' }, { name: 'h2' }])).toBe(true);
  });

  it('returns false when all harnesses are existing or disabled', async () => {
    const configIO = stubConfigIO({ h1: 'existing', h2: 'disabled' });
    expect(await hasManagedMemoryHarness(configIO, [{ name: 'h1' }, { name: 'h2' }])).toBe(false);
  });

  it('treats an unreadable harness spec as non-managed (does not throw)', async () => {
    const configIO = stubConfigIO({ h1: 'managed' });
    expect(await hasManagedMemoryHarness(configIO, [{ name: 'missing' }, { name: 'h1' }])).toBe(true);
  });
});

describe('managed-memory notice text', () => {
  it('deploy notice tells the user how to skip via redeploy', () => {
    expect(MANAGED_MEMORY_DEPLOY_NOTICE).toContain('3-5 minutes');
    expect(MANAGED_MEMORY_DEPLOY_NOTICE).toContain('redeploy with --memory-mode disabled');
  });

  it('add notice is future-tense and points at the next deploy', () => {
    expect(MANAGED_MEMORY_ADD_NOTICE).toContain('will automatically provision');
    expect(MANAGED_MEMORY_ADD_NOTICE).toContain('on deploy');
  });
});
