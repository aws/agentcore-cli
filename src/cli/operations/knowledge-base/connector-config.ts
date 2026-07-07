import type { ConnectorDataSourceType } from '../../../schema';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * User-facing `--data-source-type` flag values, including S3. `s3` is the
 * default and maps to the inline-uri S3 data source; the rest map to
 * connector-file data sources.
 */
export const DATA_SOURCE_TYPE_FLAGS = [
  's3',
  'web-crawler',
  'confluence',
  'sharepoint',
  'onedrive',
  'google-drive',
] as const;
export type DataSourceTypeFlag = (typeof DATA_SOURCE_TYPE_FLAGS)[number];

/** All wire types (including S3). */
export type DataSourceWireType = 'S3' | ConnectorDataSourceType;

/** The single translation table: user flag → wire `type`. */
export const CONNECTOR_TYPE_BY_FLAG: Record<DataSourceTypeFlag, DataSourceWireType> = {
  s3: 'S3',
  'web-crawler': 'WEB',
  confluence: 'CONFLUENCE',
  sharepoint: 'SHAREPOINT',
  onedrive: 'ONEDRIVE',
  'google-drive': 'GOOGLEDRIVE',
};

/** Inverse table, for rendering a wire type back as a user-facing flag. */
export const FLAG_BY_CONNECTOR_TYPE: Record<DataSourceWireType, DataSourceTypeFlag> = Object.fromEntries(
  Object.entries(CONNECTOR_TYPE_BY_FLAG).map(([flag, wire]) => [wire, flag])
) as Record<DataSourceWireType, DataSourceTypeFlag>;

export function flagToWireType(flag: string): DataSourceWireType {
  const wire = CONNECTOR_TYPE_BY_FLAG[flag as DataSourceTypeFlag];
  if (!wire) {
    throw new Error(`Unknown data source type "${flag}". Expected one of: ${DATA_SOURCE_TYPE_FLAGS.join(', ')}.`);
  }
  return wire;
}

/** True for every wire type that uses a connectorConfigFile (i.e. not S3). */
export function isConnectorConfigType(wire: string): wire is ConnectorDataSourceType {
  return wire !== 'S3' && wire in FLAG_BY_CONNECTOR_TYPE;
}

/** Connector wire types that require a secretArn unless explicitly NO_AUTH. */
const SECRET_BEARING: ReadonlySet<string> = new Set(['CONFLUENCE', 'SHAREPOINT', 'ONEDRIVE', 'GOOGLEDRIVE']);

export interface ConnectorConfigReadResult {
  /** The parsed connectorParameters object, passed through to the L3 verbatim. */
  parsed: Record<string, unknown> & { type: string };
  /** Non-fatal advisories surfaced to the user (e.g. missing secretArn). */
  warnings: string[];
}

/**
 * Read a `--connector-config` JSON file and validate it lightly. The CLI does
 * NOT deeply validate connector-specific structure — that lives only in the
 * file and is passed through to the DataSource verbatim (the DevEx "JSON file
 * passthrough" decision). We only check: file exists, parses, carries a `type`
 * field matching the declared connector type, and (for auth connectors) warn
 * if no secretArn is present.
 */
export function readConnectorConfig(path: string, declaredType: ConnectorDataSourceType): ConnectorConfigReadResult {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Connector config file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
  } catch {
    throw new Error(`Connector config file is not valid JSON: ${path}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Connector config file must be a JSON object: ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    throw new Error(`Connector config file is missing a "type" field: ${path}`);
  }
  if (obj.type !== declaredType) {
    throw new Error(
      `Connector config "type" (${obj.type}) does not match the declared data source type (${declaredType}) in ${path}.`
    );
  }

  const warnings: string[] = [];
  const cc = obj.connectionConfiguration as Record<string, unknown> | undefined;
  const hasSecret = !!cc && typeof cc.secretArn === 'string' && !!cc.secretArn;
  if (SECRET_BEARING.has(declaredType) && !hasSecret) {
    warnings.push(
      `Connector config ${path} has no connectionConfiguration.secretArn; ${declaredType} ingestion will fail at deploy until credentials are provided.`
    );
  }
  if (declaredType === 'WEB') {
    const authType = typeof cc?.authType === 'string' ? cc.authType : undefined;
    if (authType && authType !== 'NO_AUTH' && !hasSecret) {
      warnings.push(`Connector config ${path} uses authType ${authType} but has no secretArn.`);
    }
  }

  return { parsed: obj as ConnectorConfigReadResult['parsed'], warnings };
}

/** Pull connectionConfiguration.secretArn from a parsed connector config, if present. */
export function extractSecretArn(parsed: Record<string, unknown>): string | undefined {
  const cc = parsed.connectionConfiguration as Record<string, unknown> | undefined;
  const arn = cc?.secretArn;
  return typeof arn === 'string' && arn ? arn : undefined;
}
