import { uniqueBy } from "./zod-util";
import { z } from "zod";
export const KnowledgeBaseNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters, dashes, and underscores (max 48 chars)",
  );
const S3_BUCKET_NAME =
  /^(?!xn--)(?!sthree-)[a-z0-9](?!.*\.\.)[a-z0-9.-]{1,61}[a-z0-9](?<!-s3alias)$/;
export const S3DataSourceSchema = z
  .object({
    type: z.literal("S3"),
    uri: z
      .string()
      .min(1)
      .refine(
        (s) => {
          const m = /^s3:\/\/([^/]+)(?:\/.*)?$/.exec(s);
          return !!m && S3_BUCKET_NAME.test(m[1]!);
        },
        { message: "Must be a valid s3:// URI with an AWS-compliant bucket name" },
      ),
  })
  .strict();
export type S3DataSource = z.infer<typeof S3DataSourceSchema>;
export const ConnectorDataSourceTypeSchema = z.enum([
  "WEB",
  "CONFLUENCE",
  "SHAREPOINT",
  "ONEDRIVE",
  "GOOGLEDRIVE",
]);
export type ConnectorDataSourceType = z.infer<typeof ConnectorDataSourceTypeSchema>;
export const ConnectorFileDataSourceSchema = z
  .object({
    type: ConnectorDataSourceTypeSchema,
    connectorConfigFile: z.string().min(1, "connectorConfigFile path is required"),
  })
  .strict();
export type ConnectorFileDataSource = z.infer<typeof ConnectorFileDataSourceSchema>;
export const DataSourceSchema = z.discriminatedUnion("type", [
  S3DataSourceSchema,
  ConnectorFileDataSourceSchema,
]);
export type DataSource = z.infer<typeof DataSourceSchema>;
export const KnowledgeBaseTypeSchema = z.literal("AgentCoreKnowledgeBase");
export type KnowledgeBaseType = z.infer<typeof KnowledgeBaseTypeSchema>;
export const KnowledgeBaseSchema = z
  .object({
    type: KnowledgeBaseTypeSchema.default("AgentCoreKnowledgeBase"),
    name: KnowledgeBaseNameSchema,
    description: z.string().max(2048).optional(),
    dataSources: z
      .array(DataSourceSchema)
      .min(1, "At least one data source is required")
      .superRefine(
        uniqueBy(
          (ds) => (ds.type === "S3" ? ds.uri : ds.connectorConfigFile),
          (key) => `Duplicate data source: ${key}`,
        ),
      ),
    gateway: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;
