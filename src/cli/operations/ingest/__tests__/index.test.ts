import * as bedrockAgent from '../../../aws/bedrock-agent';
import { runKbIngestionByName } from '../index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../aws/bedrock-agent');

function deployedState(kbId: string, dataSourceIds: string[]) {
  return {
    targets: {
      default: {
        resources: {
          knowledgeBases: {
            docs: {
              knowledgeBaseId: kbId,
              knowledgeBaseArn: `arn:aws:bedrock:us-west-2:0:knowledge-base/${kbId}`,
              dataSources: dataSourceIds.map(dsId => ({
                dataSourceId: dsId,
                uri: `s3://b/${dsId}/`,
              })),
            },
          },
        },
      },
    },
  } as never;
}

describe('runKbIngestionByName', () => {
  beforeEach(() => vi.mocked(bedrockAgent.startIngestionJob).mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('starts an ingestion job per data source and returns their IDs in order', async () => {
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-2', status: 'STARTING' } as never);

    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.startedJobs).toEqual([
      { dataSourceId: 'DS1', uri: 's3://b/DS1/', ingestionJobId: 'IJ-1' },
      { dataSourceId: 'DS2', uri: 's3://b/DS2/', ingestionJobId: 'IJ-2' },
    ]);
    expect(bedrockAgent.startIngestionJob).toHaveBeenCalledTimes(2);
  });

  function deployedStateWithUris(kbId: string, dataSources: { dataSourceId: string; uri: string }[]) {
    return {
      targets: {
        default: {
          resources: {
            knowledgeBases: {
              docs: {
                knowledgeBaseId: kbId,
                knowledgeBaseArn: `arn:aws:bedrock:us-west-2:0:knowledge-base/${kbId}`,
                dataSources,
              },
            },
          },
        },
      },
    } as never;
  }

  it('ingests only the named data source when dataSourceUri is set', async () => {
    vi.mocked(bedrockAgent.startIngestionJob).mockResolvedValueOnce({
      ingestionJobId: 'IJ-2',
      status: 'STARTING',
    } as never);

    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedStateWithUris('KB1', [
        { dataSourceId: 'DS-1', uri: 's3://a/' },
        { dataSourceId: 'DS-2', uri: 's3://b/' },
      ]),
      targetName: 'default',
      region: 'us-west-2',
      dataSourceUri: 's3://b/',
      concurrentRetryPolicy: { maxAttempts: 1, delayMs: 0 },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.startedJobs).toHaveLength(1);
    expect(result.startedJobs[0]?.uri).toBe('s3://b/');
    expect(bedrockAgent.startIngestionJob).toHaveBeenCalledTimes(1);
  });

  it('errors when the named data source is not found', async () => {
    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedStateWithUris('KB1', [
        { dataSourceId: 'DS-1', uri: 's3://a/' },
        { dataSourceId: 'DS-2', uri: 's3://b/' },
      ]),
      targetName: 'default',
      region: 'us-west-2',
      dataSourceUri: 's3://nope/',
      concurrentRetryPolicy: { maxAttempts: 1, delayMs: 0 },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/s3:\/\/nope\//);
    expect(bedrockAgent.startIngestionJob).not.toHaveBeenCalled();
  });

  it("errors when the KB hasn't been deployed yet", async () => {
    const empty = { targets: { default: { resources: { knowledgeBases: {} } } } } as never;
    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: empty,
      targetName: 'default',
      region: 'us-west-2',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/has not been deployed/i);
  });

  it('errors when no data sources are recorded', async () => {
    const noDs = deployedState('KB1', []);
    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: noDs,
      targetName: 'default',
      region: 'us-west-2',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/no data sources/i);
  });

  it('reports a partial-failure result if one DS fails (other still started)', async () => {
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockRejectedValueOnce(new Error('Throttled'));

    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/1 of 2 data sources/i);
    expect(result.error.message).toMatch(/Throttled/);
  });

  it('errors when the target name does not exist in deployed-state', async () => {
    const state = deployedState('KB1', ['DS1']);
    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: state,
      targetName: 'nonexistent',
      region: 'us-west-2',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/has not been deployed/i);
  });

  it('retries the concurrent-ingestion-limit error and eventually succeeds', async () => {
    const conflictErr = Object.assign(new Error('You have reached the maximum number of concurrent ingestion jobs'), {
      name: 'ConflictException',
    });
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockRejectedValueOnce(conflictErr)
      .mockRejectedValueOnce(conflictErr)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-2', status: 'STARTING' } as never);

    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
      concurrentRetryPolicy: { maxAttempts: 5, delayMs: 0 },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.startedJobs).toEqual([
      { dataSourceId: 'DS1', uri: 's3://b/DS1/', ingestionJobId: 'IJ-1' },
      { dataSourceId: 'DS2', uri: 's3://b/DS2/', ingestionJobId: 'IJ-2' },
    ]);
    expect(bedrockAgent.startIngestionJob).toHaveBeenCalledTimes(4);
  });

  it('gives up after maxAttempts of concurrent-limit errors and reports the failure', async () => {
    const conflictErr = Object.assign(new Error('You have reached the maximum number of concurrent ingestion jobs'), {
      name: 'ConflictException',
    });
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockRejectedValueOnce(conflictErr)
      .mockRejectedValueOnce(conflictErr)
      .mockRejectedValueOnce(conflictErr);

    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
      concurrentRetryPolicy: { maxAttempts: 3, delayMs: 0 },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/1 of 2 data sources/i);
    expect(result.error.message).toMatch(/concurrent ingestion jobs/i);
    // 1 success + 3 retries on DS2
    expect(bedrockAgent.startIngestionJob).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-concurrent errors', async () => {
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockRejectedValueOnce(new Error('Throttled'));

    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
      concurrentRetryPolicy: { maxAttempts: 5, delayMs: 0 },
    });

    expect(result.success).toBe(false);
    expect(bedrockAgent.startIngestionJob).toHaveBeenCalledTimes(2);
  });

  it('emits progress messages on each retry sleep', async () => {
    const conflictErr = Object.assign(new Error('You have reached the maximum number of concurrent ingestion jobs'), {
      name: 'ConflictException',
    });
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockRejectedValueOnce(conflictErr)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-2', status: 'STARTING' } as never);

    const messages: string[] = [];
    const result = await runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
      concurrentRetryPolicy: { maxAttempts: 5, delayMs: 0 },
      onProgress: msg => messages.push(msg),
    });

    expect(result.success).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/DS2.*another ingestion job is running/);
    expect(messages[0]).toMatch(/retry 1\/4/);
  });

  it('honours an abort signal mid-sleep and reports the in-flight DS as failed', async () => {
    const conflictErr = Object.assign(new Error('You have reached the maximum number of concurrent ingestion jobs'), {
      name: 'ConflictException',
    });
    // DS1 succeeds, DS2's first attempt rejects with conflict; the loop will
    // sleep before retrying — we abort mid-sleep so the second attempt never
    // fires. Only queue what gets consumed.
    vi.mocked(bedrockAgent.startIngestionJob)
      .mockResolvedValueOnce({ ingestionJobId: 'IJ-1', status: 'STARTING' } as never)
      .mockRejectedValueOnce(conflictErr);

    const controller = new AbortController();
    const promise = runKbIngestionByName({
      knowledgeBaseName: 'docs',
      deployedState: deployedState('KB1', ['DS1', 'DS2']),
      targetName: 'default',
      region: 'us-west-2',
      concurrentRetryPolicy: { maxAttempts: 5, delayMs: 50 },
      signal: controller.signal,
    });
    // Abort while DS2 is sleeping between retries.
    setTimeout(() => controller.abort(), 5);
    const result = await promise;

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/Aborted/);
    // 1 success + 1 failed attempt; second retry never fires due to abort.
    expect(bedrockAgent.startIngestionJob).toHaveBeenCalledTimes(2);
  });
});
