import {
  CONNECTOR_TYPE_BY_FLAG,
  FLAG_BY_CONNECTOR_TYPE,
  extractSecretArn,
  flagToWireType,
  isConnectorConfigType,
  readConnectorConfig,
} from '../connector-config';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('connector-config flag↔wire mapping', () => {
  it('maps every flag to its wire type', () => {
    expect(flagToWireType('s3')).toBe('S3');
    expect(flagToWireType('web-crawler')).toBe('WEB');
    expect(flagToWireType('confluence')).toBe('CONFLUENCE');
    expect(flagToWireType('sharepoint')).toBe('SHAREPOINT');
    expect(flagToWireType('onedrive')).toBe('ONEDRIVE');
    expect(flagToWireType('google-drive')).toBe('GOOGLEDRIVE');
  });

  it('throws on an unknown flag', () => {
    expect(() => flagToWireType('dropbox')).toThrow(/unknown data source type/i);
  });

  it('round-trips flag → wire → flag', () => {
    for (const flag of Object.keys(CONNECTOR_TYPE_BY_FLAG)) {
      const wire = flagToWireType(flag);
      expect(FLAG_BY_CONNECTOR_TYPE[wire]).toBe(flag);
    }
  });

  it('identifies non-S3 connector wire types', () => {
    expect(isConnectorConfigType('WEB')).toBe(true);
    expect(isConnectorConfigType('S3')).toBe(false);
  });
});

describe('readConnectorConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads and validates a WEB config whose type matches', () => {
    const p = join(dir, 'web.json');
    writeFileSync(
      p,
      JSON.stringify({
        type: 'WEB',
        version: '1',
        connectionConfiguration: { authType: 'NO_AUTH', seedUrls: ['https://x/'] },
        crawlConfiguration: {},
      })
    );
    const r = readConnectorConfig(p, 'WEB');
    expect(r.parsed.type).toBe('WEB');
    expect(r.warnings).toHaveLength(0);
  });

  it('errors when the file is missing', () => {
    expect(() => readConnectorConfig(join(dir, 'nope.json'), 'WEB')).toThrow(/not found/i);
  });

  it('errors on invalid JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(() => readConnectorConfig(p, 'WEB')).toThrow(/not valid JSON/i);
  });

  it('errors when the parsed value is not an object', () => {
    const p = join(dir, 'arr.json');
    writeFileSync(p, '[]');
    expect(() => readConnectorConfig(p, 'WEB')).toThrow(/must be a JSON object/i);
  });

  it('errors when the config type disagrees with the declared type', () => {
    const p = join(dir, 'mismatch.json');
    writeFileSync(p, JSON.stringify({ type: 'CONFLUENCE', connectionConfiguration: {} }));
    expect(() => readConnectorConfig(p, 'WEB')).toThrow(/does not match/i);
  });

  it('warns (does not throw) when an auth connector has no secretArn', () => {
    const p = join(dir, 'conf.json');
    writeFileSync(
      p,
      JSON.stringify({ type: 'CONFLUENCE', connectionConfiguration: { hostUrl: 'https://x', authType: 'OAUTH2' } })
    );
    const r = readConnectorConfig(p, 'CONFLUENCE');
    expect(r.warnings.some(w => /secretArn/i.test(w))).toBe(true);
  });

  it('does not warn for a WEB config with NO_AUTH and no secretArn', () => {
    const p = join(dir, 'web2.json');
    writeFileSync(p, JSON.stringify({ type: 'WEB', connectionConfiguration: { authType: 'NO_AUTH' } }));
    const r = readConnectorConfig(p, 'WEB');
    expect(r.warnings).toHaveLength(0);
  });
});

describe('extractSecretArn', () => {
  it('returns the secretArn from connectionConfiguration', () => {
    expect(
      extractSecretArn({
        type: 'CONFLUENCE',
        connectionConfiguration: { secretArn: 'arn:aws:secretsmanager:us-west-2:1:secret:x' },
      })
    ).toBe('arn:aws:secretsmanager:us-west-2:1:secret:x');
  });
  it('returns undefined when absent', () => {
    expect(extractSecretArn({ type: 'WEB', connectionConfiguration: { authType: 'NO_AUTH' } })).toBeUndefined();
  });
  it('returns undefined when connectionConfiguration is missing', () => {
    expect(extractSecretArn({ type: 'WEB' })).toBeUndefined();
  });
});
