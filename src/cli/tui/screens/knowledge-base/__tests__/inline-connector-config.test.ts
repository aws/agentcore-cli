import { ConfigIO } from '../../../../../lib';
import {
  INLINE_JSON_PREFIX,
  isInlineJsonValue,
  materializeInlineConnectorConfig,
  stripInlineJsonPrefix,
} from '../inline-connector-config';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('inline-connector-config — sentinel helpers', () => {
  it('isInlineJsonValue / stripInlineJsonPrefix round-trip', () => {
    const json = '{"type":"WEB"}';
    const tagged = `${INLINE_JSON_PREFIX}${json}`;
    expect(isInlineJsonValue(tagged)).toBe(true);
    expect(isInlineJsonValue('app/kb/web.json')).toBe(false);
    expect(stripInlineJsonPrefix(tagged)).toBe(json);
    expect(stripInlineJsonPrefix('app/kb/web.json')).toBe('app/kb/web.json');
  });
});

describe('materializeInlineConnectorConfig', () => {
  let projectRoot: string;
  let configIO: ConfigIO;

  beforeEach(() => {
    // Build a minimal project tree so ConfigIO discovers the agentcore/ dir.
    projectRoot = mkdtempSync(join(tmpdir(), 'fmkb-inline-'));
    mkdirSync(join(projectRoot, 'agentcore'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'agentcore', 'agentcore.json'),
      JSON.stringify({ name: 'p', version: 1, managedBy: 'CDK', runtimes: [], memories: [], credentials: [] })
    );
    configIO = new ConfigIO({ baseDir: join(projectRoot, 'agentcore') });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes the JSON under app/<kbName>/ and returns the resulting path', async () => {
    const json = JSON.stringify({
      type: 'WEB',
      version: 1,
      connectionConfiguration: { authType: 'NO_AUTH', seedUrls: ['https://x/'] },
      crawlConfiguration: {},
    });
    const dest = await materializeInlineConnectorConfig({
      kbName: 'mykb',
      dataSourceType: 'web-crawler',
      jsonContents: json,
      configIO,
    });
    expect(dest).toBe(join(projectRoot, 'app', 'mykb', 'web-crawler-1.json'));
    expect(existsSync(dest)).toBe(true);
    // Pretty-printed and round-trips to the original object.
    const parsed = JSON.parse(readFileSync(dest, 'utf8'));
    expect(parsed.type).toBe('WEB');
    expect(parsed.connectionConfiguration.seedUrls).toEqual(['https://x/']);
    // Pretty-print: at least one newline + two-space indent line present.
    expect(readFileSync(dest, 'utf8')).toMatch(/\n {2}"type": "WEB"/);
  });

  it('avoids filename collisions by appending an incrementing suffix', async () => {
    const json = JSON.stringify({ type: 'WEB' });
    const a = await materializeInlineConnectorConfig({
      kbName: 'kb',
      dataSourceType: 'web-crawler',
      jsonContents: json,
      configIO,
    });
    const b = await materializeInlineConnectorConfig({
      kbName: 'kb',
      dataSourceType: 'web-crawler',
      jsonContents: json,
      configIO,
    });
    expect(a).toMatch(/web-crawler-1\.json$/);
    expect(b).toMatch(/web-crawler-2\.json$/);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it('rejects malformed JSON before writing anything', async () => {
    await expect(
      materializeInlineConnectorConfig({
        kbName: 'kb',
        dataSourceType: 'web-crawler',
        jsonContents: '{ not-json',
        configIO,
      })
    ).rejects.toThrow();
    expect(existsSync(join(projectRoot, 'app', 'kb'))).toBe(false);
  });
});
