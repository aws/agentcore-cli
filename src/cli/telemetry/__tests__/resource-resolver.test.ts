import { resolveResourceAttributes } from '../config';
import { ResourceAttributesSchema } from '../schemas/common-attributes';
import assert from 'node:assert';
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
    const result = await resolveResourceAttributes('cli');
    assert(result.success);
    expect(() => ResourceAttributesSchema.parse(result.resource)).not.toThrow();
  });

  it('sets service.name to agentcore-cli', async () => {
    const result = await resolveResourceAttributes('cli');
    assert(result.success);
    expect(result.resource['service.name']).toBe('agentcore-cli');
  });

  it('generates unique session_id per call', async () => {
    const a = await resolveResourceAttributes('cli');
    const b = await resolveResourceAttributes('cli');
    assert(a.success);
    assert(b.success);
    expect(a.resource['agentcore-cli.session_id']).not.toBe(b.resource['agentcore-cli.session_id']);
  });

  it('reflects the mode parameter', async () => {
    const cli = await resolveResourceAttributes('cli');
    const tui = await resolveResourceAttributes('tui');
    assert(cli.success);
    assert(tui.success);
    expect(cli.resource['agentcore-cli.mode']).toBe('cli');
    expect(tui.resource['agentcore-cli.mode']).toBe('tui');
  });

  it('populates os and node fields', async () => {
    const result = await resolveResourceAttributes('cli');
    assert(result.success);
    expect(result.resource['os.type']).toBeTruthy();
    expect(result.resource['os.version']).toBeTruthy();
    expect(result.resource['host.arch']).toBeTruthy();
    expect(result.resource['node.version']).toMatch(/^v\d+/);
  });
});
