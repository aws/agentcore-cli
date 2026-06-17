import { DataSourceSchema, KnowledgeBaseNameSchema, KnowledgeBaseSchema, S3DataSourceSchema } from '../knowledge-base';
import { describe, expect, it } from 'vitest';

describe('KnowledgeBaseNameSchema', () => {
  it('accepts a valid name', () => {
    expect(() => KnowledgeBaseNameSchema.parse('product-docs')).not.toThrow();
  });

  it('rejects names longer than 48 chars', () => {
    expect(() => KnowledgeBaseNameSchema.parse('a'.repeat(49))).toThrow();
  });

  it('rejects names that do not start with a letter', () => {
    expect(() => KnowledgeBaseNameSchema.parse('1bad')).toThrow();
  });
});

describe('S3DataSourceSchema', () => {
  it('accepts a valid S3 URI with prefix', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://my-bucket/docs/' })).not.toThrow();
  });

  it('accepts a valid S3 URI without trailing slash', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://my-bucket' })).not.toThrow();
  });

  it('rejects a non-s3 URI', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 'https://example.com' })).toThrow();
  });

  it('rejects type other than S3', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'CONFLUENCE', uri: 's3://my-bucket/y/' })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://my-bucket/', extra: 1 })).toThrow();
  });

  it('rejects bucket with uppercase letter', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://My-Bucket/x' })).toThrow();
  });

  it('rejects bucket with consecutive dots', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://my..bucket/x' })).toThrow();
  });

  it('rejects bucket with trailing dot', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://my-bucket./x' })).toThrow();
  });

  it('rejects xn-- reserved bucket prefix', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://xn--my-bucket/x' })).toThrow();
  });

  it('rejects sthree- reserved bucket prefix', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://sthree-my-bucket/x' })).toThrow();
  });

  it('rejects -s3alias reserved suffix', () => {
    expect(() => S3DataSourceSchema.parse({ type: 'S3', uri: 's3://my-bucket-s3alias/x' })).toThrow();
  });
});

describe('KnowledgeBaseSchema', () => {
  it('accepts a minimal project-owned KB entry', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'product-docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/docs/' }],
      })
    ).not.toThrow();
  });

  it('accepts multiple data sources', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'company-docs',
        dataSources: [
          { type: 'S3', uri: 's3://bucket/a/' },
          { type: 'S3', uri: 's3://bucket/b/' },
        ],
      })
    ).not.toThrow();
  });

  it('rejects entries with no data sources', () => {
    expect(() => KnowledgeBaseSchema.parse({ name: 'empty', dataSources: [] })).toThrow();
  });

  it('rejects duplicate data source URIs', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'dup',
        dataSources: [
          { type: 'S3', uri: 's3://my-bucket/a/' },
          { type: 'S3', uri: 's3://my-bucket/a/' },
        ],
      })
    ).toThrow();
  });

  it('accepts optional description and gateway', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'docs',
        description: 'Customer docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/d/' }],
        gateway: 'main-gw',
      })
    ).not.toThrow();
  });

  it('rejects unknown top-level keys', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
        foo: 'bar',
      })
    ).toThrow();
  });

  it('rejects description longer than 2048 chars', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'docs',
        description: 'x'.repeat(2049),
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
      })
    ).toThrow();
  });

  it('defaults type to AgentCoreKnowledgeBase when omitted', () => {
    const parsed = KnowledgeBaseSchema.parse({
      name: 'docs',
      dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
    });
    expect(parsed.type).toBe('AgentCoreKnowledgeBase');
  });

  it('rejects empty name', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: '',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
      })
    ).toThrow();
  });

  it('rejects empty gateway string', () => {
    expect(() =>
      KnowledgeBaseSchema.parse({
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
        gateway: '',
      })
    ).toThrow();
  });
});

describe('DataSourceSchema — connector variants', () => {
  it('accepts an S3 data source', () => {
    const r = DataSourceSchema.safeParse({ type: 'S3', uri: 's3://my-bucket/docs/' });
    expect(r.success).toBe(true);
  });

  it('accepts a WEB connector-file data source', () => {
    const r = DataSourceSchema.safeParse({ type: 'WEB', connectorConfigFile: 'app/web-docs/web.json' });
    expect(r.success).toBe(true);
  });

  it.each(['CONFLUENCE', 'SHAREPOINT', 'ONEDRIVE', 'GOOGLEDRIVE'])('accepts a %s connector-file data source', type => {
    const r = DataSourceSchema.safeParse({ type, connectorConfigFile: `app/kb/${type}.json` });
    expect(r.success).toBe(true);
  });

  it('rejects a connector-file source missing connectorConfigFile', () => {
    const r = DataSourceSchema.safeParse({ type: 'WEB' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown connector type', () => {
    const r = DataSourceSchema.safeParse({ type: 'WEBCRAWLER', connectorConfigFile: 'x.json' });
    expect(r.success).toBe(false);
  });

  it('rejects a connector-file source that also carries a uri (strict)', () => {
    const r = DataSourceSchema.safeParse({ type: 'WEB', connectorConfigFile: 'x.json', uri: 's3://b/' });
    expect(r.success).toBe(false);
  });

  it('dedups a mixed dataSources[] by uri AND connectorConfigFile', () => {
    const r = KnowledgeBaseSchema.safeParse({
      name: 'kb',
      dataSources: [
        { type: 'S3', uri: 's3://b/a/' },
        { type: 'WEB', connectorConfigFile: 'app/kb/web.json' },
        { type: 'WEB', connectorConfigFile: 'app/kb/web.json' },
      ],
    });
    expect(r.success).toBe(false);
  });
});
