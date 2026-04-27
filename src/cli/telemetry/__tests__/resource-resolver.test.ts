import { resolveResourceAttributes } from '../config';
import { ResourceAttributesSchema } from '../schemas/common-attributes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ORIGINAL_ENV = process.env.AGENTCORE_CONFIG_DIR;

describe('resolveResourceAttributes', () => {
  beforeEach(() => {
    process.env.AGENTCORE_CONFIG_DIR = '/tmp/telemetry-test-' + Date.now();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.AGENTCORE_CONFIG_DIR;
    } else {
      process.env.AGENTCORE_CONFIG_DIR = ORIGINAL_ENV;
    }
  });

  it('returns attributes that pass schema validation', async () => {
    const attrs = await resolveResourceAttributes('cli');
    expect(() => ResourceAttributesSchema.parse(attrs)).not.toThrow();
  });

  it('sets service.name to agentcore-cli', async () => {
    const attrs = await resolveResourceAttributes('cli');
    expect(attrs['service.name']).toBe('agentcore-cli');
  });

  it('generates unique session_id per call', async () => {
    const a = await resolveResourceAttributes('cli');
    const b = await resolveResourceAttributes('cli');
    expect(a['agentcore-cli.session_id']).not.toBe(b['agentcore-cli.session_id']);
  });

  it('reflects the mode parameter', async () => {
    const cli = await resolveResourceAttributes('cli');
    const tui = await resolveResourceAttributes('tui');
    expect(cli['agentcore-cli.mode']).toBe('cli');
    expect(tui['agentcore-cli.mode']).toBe('tui');
  });

  it('populates os and node fields', async () => {
    const attrs = await resolveResourceAttributes('cli');
    expect(attrs['os.type']).toBeTruthy();
    expect(attrs['os.version']).toBeTruthy();
    expect(attrs['host.arch']).toBeTruthy();
    expect(attrs['node.version']).toMatch(/^v\d+/);
  });
});
