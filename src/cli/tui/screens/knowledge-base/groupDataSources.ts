import type { DataSourceTypeFlag } from '../../../operations/knowledge-base/connector-config';
import type { CapturedDataSource } from './types';

/**
 * One group passed to a single primitive.add() call: all values share a
 * `dataSourceType`. Insertion order across groups follows the order in which
 * each type was first seen in the original list (first-seen-type wins).
 */
export interface DataSourceGroup {
  dataSourceType: DataSourceTypeFlag;
  values: string[];
}

/**
 * Group captured wizard data sources by `dataSourceType`, preserving:
 *   - first-seen-type ordering across groups, and
 *   - original insertion ordering within each group.
 *
 * Example:
 *   [
 *     { dataSourceType: 's3', value: 's3://a/' },
 *     { dataSourceType: 'web-crawler', value: 'app/k/web.json' },
 *     { dataSourceType: 's3', value: 's3://b/' },
 *   ]
 *
 * yields:
 *   [
 *     { dataSourceType: 's3', values: ['s3://a/', 's3://b/'] },
 *     { dataSourceType: 'web-crawler', values: ['app/k/web.json'] },
 *   ]
 *
 * The Flow dispatches these groups sequentially: the first becomes a
 * `primitive.add()` create call; later groups become `appendToExisting`
 * appends on the same KB.
 */
export function groupDataSources(dataSources: CapturedDataSource[]): DataSourceGroup[] {
  const groups: DataSourceGroup[] = [];
  const indexByType = new Map<DataSourceTypeFlag, number>();
  for (const ds of dataSources) {
    const idx = indexByType.get(ds.dataSourceType);
    if (idx === undefined) {
      indexByType.set(ds.dataSourceType, groups.length);
      groups.push({ dataSourceType: ds.dataSourceType, values: [ds.value] });
    } else {
      groups[idx]!.values.push(ds.value);
    }
  }
  return groups;
}
