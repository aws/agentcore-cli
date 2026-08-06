import { describe, expect, it } from "bun:test";
import { KnowledgeBaseSchema, S3DataSourceSchema } from "./knowledge-base";
describe("knowledge base custom validation", () => {
  it("validates the bucket portion of S3 URIs", () => {
    expect(
      S3DataSourceSchema.safeParse({ type: "S3", uri: "s3://valid-bucket/docs" }).success,
    ).toBe(true);
    for (const uri of ["https://bucket/docs", "s3://BadBucket/docs", "s3://bad..bucket/docs"]) {
      expect(S3DataSourceSchema.safeParse({ type: "S3", uri }).success).toBe(false);
    }
  });
  it("rejects duplicate data source locations across connector variants", () => {
    const result = KnowledgeBaseSchema.safeParse({
      name: "docs",
      dataSources: [
        { type: "WEB", connectorConfigFile: "connectors/web.json" },
        { type: "CONFLUENCE", connectorConfigFile: "connectors/web.json" },
      ],
    });
    expect(result.success).toBe(false);
  });
});
