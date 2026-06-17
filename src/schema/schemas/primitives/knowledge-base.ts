import { uniqueBy } from '../zod-util';
import { z } from 'zod';

/**
 * Knowledge Base name validation.
 * 1-48 chars, starts with a letter, alphanumeric + dash + underscore.
 * Mirrors the naming convention used by Memory/Evaluator/Dataset primitives;
 * stricter than the Bedrock CreateKnowledgeBase API allows (which permits up
 * to 100 chars), but consistent with the rest of the agentcore-cli schemas.
 */
export const KnowledgeBaseNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters, dashes, and underscores (max 48 chars)'
  );

/**
 * S3 data source for FMKB. Wave 1 supports S3 only.
 *
 * `uri` must be an `s3://bucket[/prefix]` URI. Non-S3 connectors (Confluence,
 * SharePoint, OneDrive, Google Drive, Web Crawler) are deferred to a later wave.
 *
 * Bucket validation enforces the AWS S3 bucket naming rules at parse time:
 * 3-63 chars, lowercase + digits + dot + hyphen, must start and end with
 * letter/digit, no consecutive dots, and none of the AWS-reserved prefixes
 * (`xn--`, `sthree-`) or suffixes (`-s3alias`). AWS will ultimately reject
 * non-conformant buckets server-side; failing fast at config-load time
 * gives a better error surface.
 */
const S3_BUCKET_NAME = /^(?!xn--)(?!sthree-)[a-z0-9](?!.*\.\.)[a-z0-9.-]{1,61}[a-z0-9](?<!-s3alias)$/;
export const S3DataSourceSchema = z
  .object({
    type: z.literal('S3'),
    uri: z
      .string()
      .min(1)
      .refine(
        s => {
          const m = /^s3:\/\/([^/]+)(?:\/.*)?$/.exec(s);
          return !!m && S3_BUCKET_NAME.test(m[1]!);
        },
        { message: 'Must be a valid s3:// URI with an AWS-compliant bucket name' }
      ),
  })
  .strict();

export type S3DataSource = z.infer<typeof S3DataSourceSchema>;

/**
 * Wire-verbatim connector type values for non-S3 FMKB data sources. These are
 * the exact `connectorParameters.type` literals the Bedrock managed-connector
 * API uses (confirmed against the FMKB console module's read and write paths).
 * Note `WEB` (not `WEBCRAWLER`) and the single-word `GOOGLEDRIVE`.
 */
export const ConnectorDataSourceTypeSchema = z.enum(['WEB', 'CONFLUENCE', 'SHAREPOINT', 'ONEDRIVE', 'GOOGLEDRIVE']);
export type ConnectorDataSourceType = z.infer<typeof ConnectorDataSourceTypeSchema>;

/**
 * Non-S3 data source. The connector-specific structure lives in a JSON file
 * (`connectorConfigFile`, a project-relative path) and is passed through to
 * the DataSource's connectorParameters verbatim at deploy time. This honors
 * the DevEx "JSON file passthrough" decision: new connector params don't
 * require CLI/schema changes.
 */
export const ConnectorFileDataSourceSchema = z
  .object({
    type: ConnectorDataSourceTypeSchema,
    connectorConfigFile: z.string().min(1, 'connectorConfigFile path is required'),
  })
  .strict();

export type ConnectorFileDataSource = z.infer<typeof ConnectorFileDataSourceSchema>;

/**
 * Knowledge Base data source: S3 (inline `uri`) or a non-S3 connector
 * (file-path reference). Discriminated union on `type`.
 */
export const DataSourceSchema = z.discriminatedUnion('type', [S3DataSourceSchema, ConnectorFileDataSourceSchema]);
export type DataSource = z.infer<typeof DataSourceSchema>;

/**
 * Type literal for KnowledgeBase entries in `agentcore.json`.
 * Mirrors how Memory/Evaluator/etc. tag themselves for forward-compat.
 */
export const KnowledgeBaseTypeSchema = z.literal('AgentCoreKnowledgeBase');
export type KnowledgeBaseType = z.infer<typeof KnowledgeBaseTypeSchema>;

/**
 * Knowledge Base entry. The CLI creates and owns the KB, its data sources,
 * its IAM role, and (when `gateway` is set in Wave 2) its connector gateway
 * target.
 *
 * To wire an EXTERNAL KB (one this project does not own) as a gateway target,
 * skip this schema and use a connector gateway target with the external KB's
 * literal 10-char ID set on `knowledgeBaseId`. See `agentcore add gateway-
 * target --type connector --connector bedrock-knowledge-bases`.
 *
 * `gateway` is optional in Wave 1 — when set, it's stored but not yet wired
 * to a gateway target. Wave 2 lights up the connector gateway target.
 */
export const KnowledgeBaseSchema = z
  .object({
    type: KnowledgeBaseTypeSchema.default('AgentCoreKnowledgeBase'),
    name: KnowledgeBaseNameSchema,
    description: z.string().max(2048).optional(),
    dataSources: z
      .array(DataSourceSchema)
      .min(1, 'At least one data source is required')
      .superRefine(
        uniqueBy(
          ds => (ds.type === 'S3' ? ds.uri : ds.connectorConfigFile),
          key => `Duplicate data source: ${key}`
        )
      ),
    gateway: z.string().min(1).optional(),
  })
  .strict();

export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;
