import { describe, expect, it } from "bun:test";
import {
  AgentCoreGatewaySchema,
  AgentCoreGatewayTargetSchema,
  ToolComputeConfigSchema,
} from "./gateway";
const toolDefinition = {
  name: "tool",
  description: "A tool",
  inputSchema: { type: "object" as const },
};
const lambdaCompute = {
  host: "Lambda" as const,
  implementation: { language: "Python" as const, path: "tools", handler: "handler.main" },
  pythonVersion: "PYTHON_3_12" as const,
};
describe("gateway custom validation", () => {
  it("binds compute runtime versions to implementation languages", () => {
    expect(
      ToolComputeConfigSchema.safeParse({
        host: "Lambda",
        implementation: { language: "TypeScript", path: "tools", handler: "index.handler" },
      }).success,
    ).toBe(false);
    expect(
      ToolComputeConfigSchema.safeParse({
        host: "Lambda",
        implementation: { language: "Python", path: "tools", handler: "handler.main" },
      }).success,
    ).toBe(false);
    expect(
      ToolComputeConfigSchema.safeParse({
        host: "AgentCoreRuntime",
        implementation: { language: "TypeScript", path: "tools", handler: "index.handler" },
      }).success,
    ).toBe(false);
  });
  it.each([
    ["apiGateway", {}],
    ["openApiSchema", {}],
    ["smithyModel", {}],
    ["lambdaFunctionArn", {}],
    ["mcpServer", {}],
    ["httpRuntime", {}],
    ["passthrough", {}],
    ["lambda", { toolDefinitions: [toolDefinition] }],
    ["lambda", { compute: lambdaCompute }],
    ["connector", {}],
  ])("enforces required configuration for %s targets", (targetType, extra) => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: "target",
      targetType,
      ...extra,
    });
    expect(result.success).toBe(false);
  });
  it.each([
    [
      "apiGateway",
      {
        apiGateway: {
          restApiId: "api",
          stage: "prod",
          apiGatewayToolConfiguration: { toolFilters: [{ filterPath: "/*", methods: ["GET"] }] },
        },
        endpoint: "https://example.com",
      },
    ],
    [
      "openApiSchema",
      {
        schemaSource: { inline: { path: "openapi.json" } },
        outboundAuth: { type: "OAUTH", credentialName: "oauth" },
        compute: lambdaCompute,
      },
    ],
    [
      "lambdaFunctionArn",
      {
        lambdaFunctionArn: {
          lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:tool",
          toolSchemaFile: "tools.json",
        },
        outboundAuth: { type: "NONE" },
      },
    ],
    ["httpRuntime", { httpRuntime: { runtime: "agent" }, endpoint: "https://example.com" }],
    ["connector", { connectorId: "web-search", schemaSource: { inline: { path: "schema.json" } } }],
  ])("rejects configuration that is not applicable to %s targets", (targetType, extra) => {
    const result = AgentCoreGatewayTargetSchema.safeParse({
      name: "target",
      targetType,
      ...extra,
    });
    expect(result.success).toBe(false);
  });
  it("rejects unrelated configuration fields on otherwise valid targets", () => {
    const apiGateway = {
      restApiId: "api",
      stage: "prod",
      apiGatewayToolConfiguration: { toolFilters: [{ filterPath: "/*", methods: ["GET"] }] },
    };
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "target",
        targetType: "apiGateway",
        apiGateway,
        schemaSource: { inline: { path: "schema.json" } },
      }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "target",
        targetType: "lambda",
        compute: lambdaCompute,
        toolDefinitions: [toolDefinition],
        apiGateway,
      }).success,
    ).toBe(false);
  });
  it("centralizes outbound authentication rules by target type", () => {
    const openApi = {
      name: "openapi",
      targetType: "openApiSchema",
      schemaSource: { inline: { path: "openapi.json" } },
    };
    expect(AgentCoreGatewayTargetSchema.safeParse(openApi).success).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        ...openApi,
        outboundAuth: { type: "OAUTH" },
      }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        ...openApi,
        outboundAuth: { type: "OAUTH", credentialName: "oauth" },
      }).success,
    ).toBe(true);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "http",
        targetType: "httpRuntime",
        httpRuntime: { runtime: "agent" },
        outboundAuth: { type: "API_KEY", credentialName: "key" },
      }).success,
    ).toBe(false);
  });
  it("limits passthrough-only authentication modes", () => {
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "mcp",
        targetType: "mcpServer",
        endpoint: "https://example.com/mcp",
        outboundAuth: { type: "JWT_PASSTHROUGH" },
      }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "pass",
        targetType: "passthrough",
        passthrough: { endpoint: "https://example.com", protocolType: "CUSTOM" },
        outboundAuth: { type: "GATEWAY_IAM_ROLE" },
      }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "pass",
        targetType: "passthrough",
        passthrough: { endpoint: "https://example.com", protocolType: "CUSTOM" },
        outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "execute-api" },
      }).success,
    ).toBe(true);
  });
  it("requires JWT configuration when a gateway selects CUSTOM_JWT", () => {
    const gateway = { name: "gateway", targets: [] };
    expect(
      AgentCoreGatewaySchema.safeParse({ ...gateway, authorizerType: "CUSTOM_JWT" }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewaySchema.safeParse({
        ...gateway,
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: "https://example.com/.well-known/openid-configuration",
            allowedAudience: ["audience"],
          },
        },
      }).success,
    ).toBe(true);
  });
  it("allows HTTP targets only on protocolType None gateways", () => {
    const target = {
      name: "runtime",
      targetType: "httpRuntime",
      httpRuntime: { runtime: "agent" },
    };
    expect(AgentCoreGatewaySchema.safeParse({ name: "gateway", targets: [target] }).success).toBe(
      false,
    );
    expect(
      AgentCoreGatewaySchema.safeParse({
        name: "gateway",
        protocolType: "None",
        targets: [target],
      }).success,
    ).toBe(true);
  });
});
