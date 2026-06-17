import type { DataSourceTypeFlag } from '../../../operations/knowledge-base/connector-config';

/**
 * One captured data source from the wizard. Each entry carries its own
 * `dataSourceType`, so a single wizard run can mix S3 sources with one or more
 * connector types (web-crawler, confluence, sharepoint, onedrive, google-drive).
 */
export interface CapturedDataSource {
  /** Flag form: 's3' | 'web-crawler' | 'confluence' | 'sharepoint' | 'onedrive' | 'google-drive'. */
  dataSourceType: DataSourceTypeFlag;
  /** S3 URI when dataSourceType==='s3'; connector-config file path otherwise. */
  value: string;
}

/**
 * Captured by the AddKnowledgeBaseScreen wizard and passed to the primitive's
 * add() method (potentially across multiple sequential calls — one per
 * data-source-type group).
 */
export interface AddKnowledgeBaseConfig {
  name: string;
  description?: string;
  /**
   * Heterogeneous list of captured data sources. The Flow groups these by
   * `dataSourceType` and dispatches one primitive.add() call per group; the
   * first call creates the KB, subsequent calls append.
   */
  dataSources: CapturedDataSource[];
  /**
   * Wave 2: optional name of an existing gateway to wire the new KB to as a
   * connector target. Undefined when the user skips gateway-wiring or chose
   * to create a new gateway (see `newGatewayName`). Mutually exclusive with
   * `newGatewayName`.
   */
  gateway?: string;
  /**
   * When the user chose "Create a new gateway and attach", this is the name
   * of the gateway to create. The Flow creates the gateway first, then
   * passes this name as the gateway for the KB add. Mutually exclusive with
   * `gateway`.
   */
  newGatewayName?: string;
}
