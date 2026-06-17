export interface KbIngestionDetail {
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  scanned?: number;
  indexed?: number;
  modified?: number;
  failed?: number;
  deleted?: number;
}

export interface KbDataSourceDetail {
  uri: string;
  dataSourceId: string;
  ingestion?: KbIngestionDetail;
}

export interface KbStatusDetail {
  name: string;
  knowledgeBaseId: string;
  status?: string;
  gatewayNames: string[];
  dataSources: KbDataSourceDetail[];
}

const FAILURE_HINTS = [
  'Next steps:',
  '  → Retry ingestion:  agentcore run ingest --name <kb>',
  '  → Common causes:',
  '    • Document format not supported (.txt, .md, .html, .pdf, .doc, .csv, .xls)',
  '    • File exceeds 50MB size limit',
  '    • S3 bucket permissions — ensure the KB role has s3:GetObject access',
  '    • Data source credentials expired (Confluence, SharePoint, etc.)',
];

/** Render the rich, multi-line KB status block per the DevEx spec. */
export function formatKnowledgeBaseDetail(kb: KbStatusDetail): string[] {
  const lines: string[] = [];
  lines.push(`Knowledge Base: ${kb.name}`);
  lines.push(
    `  Knowledge Base:  ${kb.status === 'ACTIVE' ? '✓' : '⟳'} ${kb.status ?? 'UNKNOWN'} (${kb.knowledgeBaseId})`
  );

  let anyFailed = false;
  lines.push(`  Data Sources (${kb.dataSources.length}):`);
  for (const ds of kb.dataSources) {
    const ing = ds.ingestion;
    const mark = ing?.status === 'FAILED' ? '✗' : ing?.status === 'COMPLETE' || ing?.status === 'SUCCEEDED' ? '✓' : '⟳';
    lines.push(`    ${mark} ${ds.uri} (${ds.dataSourceId})`);
    if (ing) {
      if (ing.status === 'FAILED') anyFailed = true;
      lines.push(`        Ingestion: ${ing.status ?? 'UNKNOWN'}`);
      if (ing.startedAt) lines.push(`        Started:   ${ing.startedAt}`);
      if (ing.completedAt) lines.push(`        Completed: ${ing.completedAt}`);
      else if (ing.updatedAt) lines.push(`        Updated:   ${ing.updatedAt}`);
      lines.push(
        `        Documents: ${ing.scanned ?? 0} scanned, ${ing.indexed ?? 0} new indexed, ${ing.modified ?? 0} modified, ${ing.failed ?? 0} failed, ${ing.deleted ?? 0} deleted`
      );
    } else {
      lines.push('        Ingestion: never run');
    }
  }

  if (kb.gatewayNames.length > 0) {
    lines.push(`  Gateways:        ${kb.gatewayNames.join(', ')}`);
    lines.push('  Tools:           retrieve (available)');
  }

  if (anyFailed) {
    lines.push('');
    lines.push(...FAILURE_HINTS.map(h => `  ${h}`));
  }

  return lines;
}

/** One-line rollup for the summary view (no --name). */
export function formatKnowledgeBaseSummaryLine(kb: KbStatusDetail): string {
  const totalIndexed = kb.dataSources.reduce((n, ds) => n + (ds.ingestion?.indexed ?? 0), 0);
  const anyFailed = kb.dataSources.some(ds => ds.ingestion?.status === 'FAILED');
  const ingesting = kb.dataSources.some(
    ds => ds.ingestion && ['IN_PROGRESS', 'STARTING', 'SUBMITTED'].includes(ds.ingestion.status ?? '')
  );
  const state = anyFailed
    ? '✗ Failed'
    : ingesting
      ? '⟳ Ingesting'
      : kb.status === 'ACTIVE'
        ? '✓ Ready'
        : (kb.status ?? 'Unknown');
  const dsCount = kb.dataSources.length;
  return `${kb.name}: ${state} (${dsCount} data source${dsCount !== 1 ? 's' : ''}, ${totalIndexed} indexed)`;
}
