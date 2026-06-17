import * as ingest from '../../ingest';
import { autoIngestKnowledgeBases, computeSourcesHash } from '../post-deploy-knowledge-bases';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../ingest');

const kbWithSources = (name: string, uris: string[]) =>
  ({
    type: 'AgentCoreKnowledgeBase',
    name,
    dataSources: uris.map(uri => ({ type: 'S3' as const, uri })),
  }) as never;

const deployedKb = (id: string, dsIds: string[], sourcesHash?: string) => ({
  knowledgeBaseId: id,
  knowledgeBaseArn: `arn:aws:bedrock:us-west-2:0:knowledge-base/${id}`,
  dataSources: dsIds.map((dsId, idx) => ({
    dataSourceId: dsId,
    uri: `s3://b/ds${idx}/`,
  })),
  ...(sourcesHash && { sourcesHash }),
});

const stubDeployedState = () => ({ targets: { default: { resources: { knowledgeBases: {} } } } }) as never;

describe('computeSourcesHash', () => {
  it('produces a stable hash for identical URI lists', () => {
    const kb1 = kbWithSources('a', ['s3://b/x/', 's3://b/y/']);
    const kb2 = kbWithSources('a', ['s3://b/x/', 's3://b/y/']);
    expect(computeSourcesHash(kb1)).toBe(computeSourcesHash(kb2));
  });

  it('produces different hashes when a URI changes', () => {
    const kb1 = kbWithSources('a', ['s3://b/x/']);
    const kb2 = kbWithSources('a', ['s3://b/y/']);
    expect(computeSourcesHash(kb1)).not.toBe(computeSourcesHash(kb2));
  });

  it('produces different hashes when URI order changes', () => {
    const kb1 = kbWithSources('a', ['s3://b/x/', 's3://b/y/']);
    const kb2 = kbWithSources('a', ['s3://b/y/', 's3://b/x/']);
    expect(computeSourcesHash(kb1)).not.toBe(computeSourcesHash(kb2));
  });
});

describe('autoIngestKnowledgeBases', () => {
  beforeEach(() => vi.mocked(ingest.runKbIngestionByName).mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('starts ingestion for a KB with no prior hash (first deploy)', async () => {
    vi.mocked(ingest.runKbIngestionByName).mockResolvedValueOnce({
      success: true,
      startedJobs: [{ dataSourceId: 'DS1', uri: 's3://b/ds0/', ingestionJobId: 'IJ-1' }],
    } as never);

    const result = await autoIngestKnowledgeBases({
      region: 'us-west-2',
      knowledgeBases: [kbWithSources('docs', ['s3://b/ds0/'])],
      deployedKnowledgeBases: { docs: deployedKb('KB1', ['DS1']) },
      previousKnowledgeBases: undefined,
      targetName: 'default',
      deployedState: stubDeployedState(),
    });

    expect(result.hasErrors).toBe(false);
    expect(result.results).toHaveLength(1);
    const entry = result.results[0]!;
    expect(entry.status).toBe('started');
    expect(entry.startedJobCount).toBe(1);
    expect(entry.newSourcesHash).toBeTruthy();
  });

  it('skips ingestion when sourcesHash matches the prior deploy', async () => {
    const kb = kbWithSources('docs', ['s3://b/ds0/']);
    const priorHash = computeSourcesHash(kb);

    const result = await autoIngestKnowledgeBases({
      region: 'us-west-2',
      knowledgeBases: [kb],
      deployedKnowledgeBases: { docs: deployedKb('KB1', ['DS1']) },
      previousKnowledgeBases: { docs: deployedKb('KB1', ['DS1'], priorHash) },
      targetName: 'default',
      deployedState: stubDeployedState(),
    });

    expect(result.hasErrors).toBe(false);
    expect(result.results[0]?.status).toBe('skipped');
    expect(result.results[0]?.reason).toMatch(/no changes/i);
    expect(ingest.runKbIngestionByName).not.toHaveBeenCalled();
  });

  it('starts ingestion when sourcesHash differs from prior', async () => {
    vi.mocked(ingest.runKbIngestionByName).mockResolvedValueOnce({
      success: true,
      startedJobs: [{ dataSourceId: 'DS1', uri: 's3://b/ds0/', ingestionJobId: 'IJ-1' }],
    } as never);

    const result = await autoIngestKnowledgeBases({
      region: 'us-west-2',
      knowledgeBases: [kbWithSources('docs', ['s3://b/ds0/'])],
      deployedKnowledgeBases: { docs: deployedKb('KB1', ['DS1']) },
      previousKnowledgeBases: { docs: deployedKb('KB1', ['DS1'], 'old-hash') },
      targetName: 'default',
      deployedState: stubDeployedState(),
    });

    expect(result.results[0]?.status).toBe('started');
    expect(ingest.runKbIngestionByName).toHaveBeenCalledTimes(1);
  });

  it('records errors but does not abort other KBs', async () => {
    vi.mocked(ingest.runKbIngestionByName)
      .mockResolvedValueOnce({ success: false, error: new Error('Throttled') } as never)
      .mockResolvedValueOnce({
        success: true,
        startedJobs: [{ dataSourceId: 'DS2', uri: 's3://b/ds0/', ingestionJobId: 'IJ-2' }],
      } as never);

    const result = await autoIngestKnowledgeBases({
      region: 'us-west-2',
      knowledgeBases: [kbWithSources('a', ['s3://b/ds0/']), kbWithSources('b', ['s3://b/ds0/'])],
      deployedKnowledgeBases: {
        a: deployedKb('KB1', ['DS1']),
        b: deployedKb('KB2', ['DS2']),
      },
      previousKnowledgeBases: undefined,
      targetName: 'default',
      deployedState: stubDeployedState(),
    });

    expect(result.hasErrors).toBe(true);
    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.error).toMatch(/Throttled/);
    expect(result.results[1]?.status).toBe('started');
  });

  it('skips a KB that has no data sources recorded yet', async () => {
    const result = await autoIngestKnowledgeBases({
      region: 'us-west-2',
      knowledgeBases: [kbWithSources('docs', ['s3://b/ds0/'])],
      deployedKnowledgeBases: { docs: deployedKb('KB1', []) },
      previousKnowledgeBases: undefined,
      targetName: 'default',
      deployedState: stubDeployedState(),
    });

    expect(result.results[0]?.status).toBe('skipped');
    expect(result.results[0]?.reason).toMatch(/no data sources/i);
    expect(ingest.runKbIngestionByName).not.toHaveBeenCalled();
  });

  it('skips a KB that is missing from deployed state (CFN outputs missing)', async () => {
    const result = await autoIngestKnowledgeBases({
      region: 'us-west-2',
      knowledgeBases: [kbWithSources('docs', ['s3://b/ds0/'])],
      deployedKnowledgeBases: {},
      previousKnowledgeBases: undefined,
      targetName: 'default',
      deployedState: stubDeployedState(),
    });

    expect(result.results[0]?.status).toBe('skipped');
    expect(result.results[0]?.reason).toMatch(/not present in deployed state/i);
  });
});
