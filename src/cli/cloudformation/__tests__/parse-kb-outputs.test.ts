import { parseKnowledgeBaseDataSourceOutputs, parseKnowledgeBaseOutputs } from '../outputs';
import { describe, expect, it } from 'vitest';

describe('parseKnowledgeBaseOutputs', () => {
  it('hydrates dataSources[] from per-DS CFN outputs (L3 #234+)', () => {
    const outputs = {
      ApplicationKnowledgeBaseProductDocsIdOutput06769C35: 'KB1',
      ApplicationKnowledgeBaseProductDocsArnOutput9B6F9B44: 'arn:aws:bedrock:us-west-2:0:knowledge-base/KB1',
      ApplicationKnowledgeBaseProductDocsDataSource0IdOutput750CF2FE: 'DS-A',
      ApplicationKnowledgeBaseProductDocsDataSource0UriOutput07D6B66D: 's3://bucket-a/docs/',
      ApplicationKnowledgeBaseProductDocsDataSource1IdOutput9DF50FA0: 'DS-B',
      ApplicationKnowledgeBaseProductDocsDataSource1UriOutputAA112233: 's3://bucket-b/',
    };
    const result = parseKnowledgeBaseOutputs(outputs, ['product-docs']);
    expect(result['product-docs']).toEqual({
      knowledgeBaseId: 'KB1',
      knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:0:knowledge-base/KB1',
      dataSources: [
        { dataSourceId: 'DS-A', uri: 's3://bucket-a/docs/' },
        { dataSourceId: 'DS-B', uri: 's3://bucket-b/' },
      ],
    });
  });

  it('returns empty dataSources[] when per-DS outputs are absent (older L3)', () => {
    const outputs = {
      ApplicationKnowledgeBaseProductDocsIdOutput06769C35: 'KB1',
      ApplicationKnowledgeBaseProductDocsArnOutput9B6F9B44: 'arn:x',
    };
    const result = parseKnowledgeBaseOutputs(outputs, ['product-docs']);
    expect(result['product-docs']?.dataSources).toEqual([]);
  });

  it('omits a KB whose Id/Arn outputs are missing entirely', () => {
    const outputs = {
      SomeOtherOutput: 'irrelevant',
    };
    const result = parseKnowledgeBaseOutputs(outputs, ['product-docs']);
    expect(result['product-docs']).toBeUndefined();
  });
});

describe('parseKnowledgeBaseDataSourceOutputs', () => {
  it('orders entries by index even when stack outputs come back unordered', () => {
    const outputs = {
      ApplicationKnowledgeBaseDocsDataSource2IdOutputAAAAAAAA: 'DS-2',
      ApplicationKnowledgeBaseDocsDataSource0IdOutputBBBBBBBB: 'DS-0',
      ApplicationKnowledgeBaseDocsDataSource1IdOutputCCCCCCCC: 'DS-1',
      ApplicationKnowledgeBaseDocsDataSource0UriOutputDDDDDDDD: 's3://0/',
      ApplicationKnowledgeBaseDocsDataSource1UriOutputEEEEEEEE: 's3://1/',
      ApplicationKnowledgeBaseDocsDataSource2UriOutputFFFFFFFF: 's3://2/',
    };
    expect(parseKnowledgeBaseDataSourceOutputs(outputs, 'docs')).toEqual([
      { dataSourceId: 'DS-0', uri: 's3://0/' },
      { dataSourceId: 'DS-1', uri: 's3://1/' },
      { dataSourceId: 'DS-2', uri: 's3://2/' },
    ]);
  });

  it('drops orphan entries (Id without Uri or vice versa)', () => {
    const outputs = {
      ApplicationKnowledgeBaseDocsDataSource0IdOutputAAAAAAAA: 'DS-0',
      // no DataSource0UriOutput
      ApplicationKnowledgeBaseDocsDataSource1IdOutputBBBBBBBB: 'DS-1',
      ApplicationKnowledgeBaseDocsDataSource1UriOutputCCCCCCCC: 's3://1/',
    };
    expect(parseKnowledgeBaseDataSourceOutputs(outputs, 'docs')).toEqual([{ dataSourceId: 'DS-1', uri: 's3://1/' }]);
  });
});
