import type { ConfigIO } from '../../../../lib';
import {
  MANAGED_MEMORY_ADD_NOTICE,
  MANAGED_MEMORY_DEPLOY_NOTICE,
  hasManagedMemoryHarness,
} from '../managed-memory-notice';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => {
    vi.clearAllMocks();
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

  it('returns false for a harness whose memory config is OMITTED (omitted opts out → Disabled, no provisioning)', async () => {
    // mode undefined → stub resolves { memory: undefined } (omitted). The CDK now synthesizes
    // Memory: { Disabled: {} } for omitted, so no memory is provisioned and the notice must not fire.
    const configIO = stubConfigIO({ h1: undefined });
    expect(await hasManagedMemoryHarness(configIO, [{ name: 'h1' }])).toBe(false);
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
    expect(MANAGED_MEMORY_ADD_NOTICE).toContain('will provision');
    expect(MANAGED_MEMORY_ADD_NOTICE).toContain('on deploy');
  });

  it('notices reflect opt-in managed (do NOT call managed the default)', () => {
    expect(MANAGED_MEMORY_DEPLOY_NOTICE).not.toContain('the default');
    expect(MANAGED_MEMORY_ADD_NOTICE).not.toContain('the default');
    expect(MANAGED_MEMORY_DEPLOY_NOTICE).toContain('--memory-mode managed');
  });
});
