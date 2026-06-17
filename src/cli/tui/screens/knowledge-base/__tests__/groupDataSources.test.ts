import { groupDataSources } from '../groupDataSources';
import { describe, expect, it } from 'vitest';

describe('groupDataSources', () => {
  it('returns empty array for empty input', () => {
    expect(groupDataSources([])).toEqual([]);
  });

  it('groups a single-type list into one group', () => {
    const result = groupDataSources([
      { dataSourceType: 's3', value: 's3://a/' },
      { dataSourceType: 's3', value: 's3://b/' },
    ]);
    expect(result).toEqual([{ dataSourceType: 's3', values: ['s3://a/', 's3://b/'] }]);
  });

  it('groups by type and preserves first-seen-type ordering across groups', () => {
    const result = groupDataSources([
      { dataSourceType: 's3', value: 's3://a/' },
      { dataSourceType: 'web-crawler', value: 'app/k/web.json' },
      { dataSourceType: 's3', value: 's3://b/' },
      { dataSourceType: 'confluence', value: 'app/k/conf.json' },
      { dataSourceType: 'web-crawler', value: 'app/k/web2.json' },
    ]);
    expect(result).toEqual([
      { dataSourceType: 's3', values: ['s3://a/', 's3://b/'] },
      { dataSourceType: 'web-crawler', values: ['app/k/web.json', 'app/k/web2.json'] },
      { dataSourceType: 'confluence', values: ['app/k/conf.json'] },
    ]);
  });

  it('preserves insertion order within a group', () => {
    const result = groupDataSources([
      { dataSourceType: 'web-crawler', value: 'first.json' },
      { dataSourceType: 'web-crawler', value: 'second.json' },
      { dataSourceType: 'web-crawler', value: 'third.json' },
    ]);
    expect(result[0]!.values).toEqual(['first.json', 'second.json', 'third.json']);
  });

  it('handles a single source per type with no inter-group reordering', () => {
    const result = groupDataSources([
      { dataSourceType: 'confluence', value: 'a' },
      { dataSourceType: 's3', value: 's3://b/' },
      { dataSourceType: 'web-crawler', value: 'c' },
    ]);
    expect(result.map(g => g.dataSourceType)).toEqual(['confluence', 's3', 'web-crawler']);
  });
});
