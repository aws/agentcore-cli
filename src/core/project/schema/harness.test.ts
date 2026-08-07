import { describe, expect, it } from "bun:test";
import {
  HarnessMemoryRefSchema,
  HarnessModelSchema,
  HarnessSpecSchema,
  HarnessToolSchema,
  HarnessTruncationConfigSchema,
  HarnessMemoryRetrievalConfigSchema,
  looksLikeLegacyPromptPath,
  validateApiFormat,
} from "./harness";
const minimalHarness = {
  name: "harness",
  model: { provider: "bedrock" as const, modelId: "model" },
};
const networkConfig = {
  subnets: ["subnet-0123456789abcdef0"],
  securityGroups: ["sg-0123456789abcdef0"],
};
describe("harness custom validation", () => {
  it("binds model-only fields to their providers", () => {
    expect(HarnessModelSchema.safeParse({ provider: "open_ai", modelId: "gpt" }).success).toBe(
      false,
    );
    expect(
      HarnessModelSchema.safeParse({
        provider: "gemini",
        modelId: "gemini",
        apiKeyArn: "arn:key",
        topK: 40,
      }).success,
    ).toBe(true);
    expect(
      HarnessModelSchema.safeParse({ provider: "bedrock", modelId: "model", topK: 40 }).success,
    ).toBe(false);
    expect(
      HarnessModelSchema.safeParse({
        provider: "bedrock",
        modelId: "model",
        apiBase: "https://proxy.example.com",
      }).success,
    ).toBe(false);
  });
  it("validates provider-specific API formats through the shared helper", () => {
    expect(validateApiFormat("responses", "open_ai")).toEqual({ valid: true });
    expect(validateApiFormat("converse_stream", "open_ai").valid).toBe(false);
    expect(validateApiFormat("responses", "gemini").valid).toBe(false);
    expect(validateApiFormat("unknown", "bedrock").valid).toBe(false);
  });
  it("binds tool types to their configuration arms", () => {
    expect(
      HarnessToolSchema.safeParse({
        type: "remote_mcp",
        name: "mcp",
        config: { remoteMcp: { url: "https://example.com/mcp" } },
      }).success,
    ).toBe(true);
    expect(HarnessToolSchema.safeParse({ type: "remote_mcp", name: "mcp" }).success).toBe(false);
    expect(
      HarnessToolSchema.safeParse({
        type: "remote_mcp",
        name: "mcp",
        config: { agentCoreBrowser: {} },
      }).success,
    ).toBe(false);
    expect(
      HarnessToolSchema.safeParse({
        type: "remote_mcp",
        name: "mcp",
        config: {
          remoteMcp: { url: "https://example.com/mcp" },
          agentCoreBrowser: {},
        },
      }).success,
    ).toBe(false);
  });
  it("rejects the removed gateway credentialProviderName with migration guidance", () => {
    const result = HarnessToolSchema.safeParse({
      type: "agentcore_gateway",
      name: "gateway",
      config: {
        agentCoreGateway: {
          gatewayArn: "arn:gateway",
          credentialProviderName: "legacy",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message.includes("no longer supported")),
      ).toBe(true);
    }
  });
  it("normalizes legacy memory references without inventing memory", () => {
    expect(HarnessMemoryRefSchema.parse({ name: "memory" })).toEqual({
      mode: "existing",
      name: "memory",
    });
    expect(HarnessSpecSchema.parse(minimalHarness).memory).toBeUndefined();
  });
  it("validates existing-memory references and retrieval tuning", () => {
    expect(HarnessMemoryRefSchema.safeParse({ mode: "existing" }).success).toBe(false);
    expect(HarnessMemoryRetrievalConfigSchema.safeParse({}).success).toBe(false);
    expect(
      HarnessMemoryRefSchema.safeParse({
        mode: "existing",
        arn: "arn:memory",
        retrievalConfig: { topK: 5 },
      }).success,
    ).toBe(false);
    expect(
      HarnessMemoryRefSchema.safeParse({
        mode: "existing",
        name: "memory",
        retrievalConfig: { topK: 5 },
      }).success,
    ).toBe(true);
  });
  it("binds truncation configuration to its strategy", () => {
    expect(
      HarnessTruncationConfigSchema.safeParse({
        strategy: "sliding_window",
        config: { summarization: { summaryRatio: 0.5 } },
      }).success,
    ).toBe(false);
    expect(
      HarnessTruncationConfigSchema.safeParse({
        strategy: "none",
        config: { slidingWindow: { preserveRecentMessages: 5 } },
      }).success,
    ).toBe(false);
  });
  it("rejects legacy path-shaped and blank system prompts", () => {
    expect(looksLikeLegacyPromptPath("./prompt.md")).toBe(true);
    expect(looksLikeLegacyPromptPath("Use prompt.md when needed")).toBe(false);
    expect(
      HarnessSpecSchema.safeParse({ ...minimalHarness, systemPrompt: "./prompt.md" }).success,
    ).toBe(false);
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, systemPrompt: "   " }).success).toBe(
      false,
    );
  });
  it("rejects duplicate tools and excessive environment variables", () => {
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        tools: [
          { type: "agentcore_browser", name: "same" },
          { type: "agentcore_code_interpreter", name: "same" },
        ],
      }).success,
    ).toBe(false);
    const environmentVariables = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`KEY_${index}`, "value"]),
    );
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, environmentVariables }).success).toBe(
      false,
    );
  });
  it("enforces mutually exclusive build sources and VPC configuration coupling", () => {
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag",
        dockerfile: "Dockerfile",
      }).success,
    ).toBe(false);
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, networkMode: "VPC" }).success).toBe(
      false,
    );
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, networkConfig }).success).toBe(false);
  });
  it("requires a VPC ID only for Dockerfile builds in VPC mode", () => {
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        dockerfile: "Dockerfile",
        networkMode: "VPC",
        networkConfig,
      }).success,
    ).toBe(false);
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        dockerfile: "Dockerfile",
        networkMode: "VPC",
        networkConfig: { ...networkConfig, vpcId: "vpc-0123456789abcdef0" },
      }).success,
    ).toBe(true);
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag",
        networkMode: "VPC",
        networkConfig,
      }).success,
    ).toBe(true);
  });
  it("requires VPC mode for external mounts and unique mount paths", () => {
    const efsAccessPoints = [
      {
        accessPointArn:
          "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/data",
      },
    ];
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, efsAccessPoints }).success).toBe(false);
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        networkMode: "VPC",
        networkConfig,
        sessionStoragePath: "/mnt/data/",
        efsAccessPoints,
      }).success,
    ).toBe(false);
  });
  it("enforces inbound auth coupling", () => {
    expect(
      HarnessSpecSchema.safeParse({ ...minimalHarness, authorizerType: "CUSTOM_JWT" }).success,
    ).toBe(false);
    expect(
      HarnessSpecSchema.safeParse({
        ...minimalHarness,
        authorizerType: "AWS_IAM",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: "https://example.com/.well-known/openid-configuration",
          },
        },
      }).success,
    ).toBe(false);
  });
  it("applies the CodeBuild security-group cap to every container build source", () => {
    const securityGroups = Array.from(
      { length: 6 },
      (_, index) => `sg-${String(index + 1).padStart(17, "0")}`,
    );
    for (const source of [
      { dockerfile: "Dockerfile" },
      { containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag" },
    ]) {
      expect(
        HarnessSpecSchema.safeParse({
          ...minimalHarness,
          ...source,
          networkMode: "VPC",
          networkConfig: { ...networkConfig, securityGroups },
        }).success,
      ).toBe(false);
    }
  });
});
