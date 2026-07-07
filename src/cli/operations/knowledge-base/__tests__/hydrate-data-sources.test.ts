import * as bedrockAgent from '../../../aws/bedrock-agent';
import { hydrateKnowledgeBaseDataSources } from '../hydrate-data-sources';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../aws/bedrock-agent');

describe('hydrateKnowledgeBaseDataSources', () => {
  beforeEach(() => vi.mocked(bedrockAgent.listDataSources).mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('falls back to listDataSources, mapping deployed DSes by URI hash suffix', async () => {
    // Stack pre-dates the per-DS CFN outputs from L3 #234, so dataSources is
    // empty when we get here. The L3 names each DS as
    //   `${kbPhysicalName}_ds_${first8charsOfSha256(uri)}`
    // Hashes computed from the URIs below:
    //   s3://b/a/ → 28ebaa59
    //   s3://b/b/ → 87791e1d
    // ListDataSources order is not guaranteed; we recover the URI by hash.
    vi.mocked(bedrockAgent.listDataSources).mockResolvedValueOnce([
      { dataSourceId: 'DS-second', name: 'TestProj_docs_ds_87791e1d', status: 'AVAILABLE' },
      { dataSourceId: 'DS-first', name: 'TestProj_docs_ds_28ebaa59', status: 'AVAILABLE' },
    ] as never);

    const knowledgeBases = {
      docs: {
        knowledgeBaseId: 'KB1',
        knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:0:knowledge-base/KB1',
        dataSources: [],
      },
    };

    await hydrateKnowledgeBaseDataSources({
      knowledgeBases,
      knowledgeBaseSpecs: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'docs',
          dataSources: [
            { type: 'S3', uri: 's3://b/a/' },
            { type: 'S3', uri: 's3://b/b/' },
          ],
        } as never,
      ],
      region: 'us-west-2',
    });

    expect(knowledgeBases.docs.dataSources).toEqual([
      { dataSourceId: 'DS-first', uri: 's3://b/a/' },
      { dataSourceId: 'DS-second', uri: 's3://b/b/' },
    ]);
  });

  it('is a no-op when CFN outputs already populated dataSources[]', async () => {
    const listSpy = vi.mocked(bedrockAgent.listDataSources).mockResolvedValue([] as never);
    const knowledgeBases = {
      docs: {
        knowledgeBaseId: 'KB1',
        knowledgeBaseArn: 'arn:x',
        dataSources: [{ dataSourceId: 'DS-from-cfn', uri: 's3://b/a/' }],
      },
    };

    await hydrateKnowledgeBaseDataSources({
      knowledgeBases,
      knowledgeBaseSpecs: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'docs',
          dataSources: [{ type: 'S3', uri: 's3://b/a/' }],
        } as never,
      ],
      region: 'us-west-2',
    });

    expect(listSpy).not.toHaveBeenCalled();
    expect(knowledgeBases.docs.dataSources).toEqual([{ dataSourceId: 'DS-from-cfn', uri: 's3://b/a/' }]);
  });

  it('leaves dataSources empty if listDataSources returns []', async () => {
    vi.mocked(bedrockAgent.listDataSources).mockResolvedValueOnce([]);
    const knowledgeBases = {
      docs: { knowledgeBaseId: 'KB1', knowledgeBaseArn: 'arn:x', dataSources: [] as never[] },
    };
    await hydrateKnowledgeBaseDataSources({
      knowledgeBases,
      knowledgeBaseSpecs: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'docs',
          dataSources: [{ type: 'S3', uri: 's3://b/d/' }],
        } as never,
      ],
      region: 'us-west-2',
    });
    expect(knowledgeBases.docs.dataSources).toEqual([]);
  });

  it('skips KBs without a matching local spec', async () => {
    const listSpy = vi.mocked(bedrockAgent.listDataSources).mockResolvedValue([] as never);
    const knowledgeBases = {
      orphan: { knowledgeBaseId: 'KB1', knowledgeBaseArn: 'arn:x', dataSources: [] as never[] },
    };
    await hydrateKnowledgeBaseDataSources({
      knowledgeBases,
      knowledgeBaseSpecs: [], // no specs
      region: 'us-west-2',
    });
    expect(listSpy).not.toHaveBeenCalled();
  });
});
