import { readConnectorConfig } from '../connector-config';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../../../docs/connector-config-templates');

describe('connector-config templates parse', () => {
  it.each([
    ['web-crawler.json', 'WEB'],
    ['confluence.json', 'CONFLUENCE'],
    ['sharepoint.json', 'SHAREPOINT'],
    ['onedrive.json', 'ONEDRIVE'],
    ['google-drive.json', 'GOOGLEDRIVE'],
  ] as const)('%s validates as %s', (file, type) => {
    const r = readConnectorConfig(join(ROOT, file), type);
    expect(r.parsed.type).toBe(type);
  });
});
