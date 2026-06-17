import {
  type KbStatusDetail,
  formatKnowledgeBaseDetail,
  formatKnowledgeBaseSummaryLine,
} from '../format-knowledge-base';
import { describe, expect, it } from 'vitest';

const base: KbStatusDetail = {
  name: 'product-docs',
  knowledgeBaseId: 'KB-ABC',
  status: 'ACTIVE',
  gatewayNames: ['main-gw'],
  dataSources: [
    {
      uri: 's3://bucket/docs/',
      dataSourceId: 'DS-1',
      ingestion: {
        status: 'COMPLETE',
        startedAt: '2026-02-20T23:03:36Z',
        completedAt: '2026-02-20T23:15:42Z',
        scanned: 141,
        indexed: 138,
        modified: 0,
        failed: 3,
        deleted: 0,
      },
    },
  ],
};

describe('formatKnowledgeBaseDetail', () => {
  it('renders a multi-line block with per-DS state and tool line', () => {
    const text = formatKnowledgeBaseDetail(base).join('\n');
    expect(text).toContain('KB-ABC');
    expect(text).toContain('s3://bucket/docs/');
    expect(text).toContain('138 new indexed');
    expect(text).toContain('Tools:');
    expect(text).toContain('retrieve');
  });

  it('renders troubleshooting hints on ingestion failure', () => {
    const ds0 = base.dataSources[0]!;
    const failed: KbStatusDetail = {
      ...base,
      dataSources: [{ ...ds0, ingestion: { ...ds0.ingestion, status: 'FAILED' } }],
    };
    const text = formatKnowledgeBaseDetail(failed).join('\n');
    expect(text).toContain('Next steps');
    expect(text).toMatch(/50MB|file format|s3:GetObject/i);
  });

  it('omits the tool line when not wired to any gateway', () => {
    const standalone = { ...base, gatewayNames: [] };
    const text = formatKnowledgeBaseDetail(standalone).join('\n');
    expect(text).not.toContain('Tools:');
  });

  it('shows "never run" when a data source has no ingestion', () => {
    const noIngest = { ...base, dataSources: [{ uri: 's3://b/', dataSourceId: 'DS-9' }] };
    const text = formatKnowledgeBaseDetail(noIngest).join('\n');
    expect(text).toContain('never run');
  });

  it('lists every data source for a multi-DS KB', () => {
    const multi = {
      ...base,
      dataSources: [
        { uri: 's3://b/a/', dataSourceId: 'DS-1', ingestion: { status: 'COMPLETE', scanned: 1, indexed: 1 } },
        { uri: 's3://b/c/', dataSourceId: 'DS-2', ingestion: { status: 'IN_PROGRESS', scanned: 5, indexed: 0 } },
      ],
    };
    const text = formatKnowledgeBaseDetail(multi).join('\n');
    expect(text).toContain('s3://b/a/');
    expect(text).toContain('s3://b/c/');
  });
});

describe('formatKnowledgeBaseSummaryLine', () => {
  it('renders name, Ready state, count, and indexed total for an ACTIVE KB with complete ingestion', () => {
    const line = formatKnowledgeBaseSummaryLine(base);
    expect(line).toContain('product-docs');
    expect(line).toContain('Ready');
    expect(line).toContain('1 data source');
    expect(line).toContain('138 indexed');
  });

  it('shows Failed when any data source ingestion failed', () => {
    const ds0 = base.dataSources[0]!;
    const failed: KbStatusDetail = {
      ...base,
      dataSources: [{ ...ds0, ingestion: { ...ds0.ingestion, status: 'FAILED' } }],
    };
    expect(formatKnowledgeBaseSummaryLine(failed)).toContain('Failed');
  });

  it('shows Ingesting when a data source is in progress', () => {
    const ds0 = base.dataSources[0]!;
    const ingesting: KbStatusDetail = {
      ...base,
      dataSources: [{ ...ds0, ingestion: { ...ds0.ingestion, status: 'IN_PROGRESS' } }],
    };
    expect(formatKnowledgeBaseSummaryLine(ingesting)).toContain('Ingesting');
  });

  it('sums indexed across data sources for a multi-DS KB', () => {
    const multi: KbStatusDetail = {
      ...base,
      dataSources: [
        { uri: 's3://b/a/', dataSourceId: 'DS-1', ingestion: { status: 'COMPLETE', indexed: 100 } },
        { uri: 's3://b/c/', dataSourceId: 'DS-2', ingestion: { status: 'COMPLETE', indexed: 50 } },
      ],
    };
    const line = formatKnowledgeBaseSummaryLine(multi);
    expect(line).toContain('2 data sources');
    expect(line).toContain('150 indexed');
  });
});
