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
const githubPassthrough = {
  name: "github",
  targetType: "passthrough",
  passthrough: { endpoint: "https://api.github.com", protocolType: "CUSTOM" },
};
const apiKeyAuth = { type: "API_KEY", credentialName: "githubToken" };
const targetIssues = (target: object) =>
  AgentCoreGatewayTargetSchema.safeParse(target).error?.issues.map(({ path, message }) => ({
    path,
    message,
  }));
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
  it.each([
    [
      "mcpServer",
      {
        endpoint: "https://example.com/mcp",
      },
    ],
    [
      "openApiSchema",
      {
        schemaSource: { inline: { path: "openapi.json" } },
      },
    ],
  ])("allows configured IAM role authentication for %s targets", (targetType, configuration) => {
    const target = {
      name: "target",
      targetType,
      ...configuration,
    };
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        ...target,
        outboundAuth: { type: "GATEWAY_IAM_ROLE" },
      }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        ...target,
        outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore" },
      }).success,
    ).toBe(true);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        ...target,
        outboundAuth: {
          type: "GATEWAY_IAM_ROLE",
          service: "bedrock-agentcore",
          region: "us-east-1",
        },
      }).success,
    ).toBe(true);
  });
  it("rejects IAM signing fields for other outbound authentication types", () => {
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "mcp",
        targetType: "mcpServer",
        endpoint: "https://example.com/mcp",
        outboundAuth: { type: "NONE", service: "bedrock-agentcore" },
      }).success,
    ).toBe(false);
    expect(
      AgentCoreGatewayTargetSchema.safeParse({
        name: "openapi",
        targetType: "openApiSchema",
        schemaSource: { inline: { path: "openapi.json" } },
        outboundAuth: {
          type: "OAUTH",
          credentialName: "oauth",
          region: "us-east-1",
        },
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
  it.each([
    ["passthrough with no API key placement", githubPassthrough, {}],
    [
      "passthrough with an Authorization Bearer header",
      githubPassthrough,
      { location: "HEADER", parameterName: "Authorization", prefix: "Bearer" },
    ],
    [
      "openApiSchema with an API key query parameter",
      {
        name: "weather",
        targetType: "openApiSchema",
        schemaSource: { inline: { path: "openapi.json" } },
      },
      { location: "QUERY_PARAMETER", parameterName: "api_key" },
    ],
    [
      "apiGateway with a custom API key header",
      {
        name: "pets",
        targetType: "apiGateway",
        apiGateway: {
          restApiId: "api",
          stage: "prod",
          apiGatewayToolConfiguration: { toolFilters: [{ filterPath: "/*", methods: ["GET"] }] },
        },
      },
      { parameterName: "X-Pets-Key" },
    ],
    [
      "a query parameter name with a colon",
      githubPassthrough,
      { location: "QUERY_PARAMETER", parameterName: "api:key" },
    ],
    [
      "a query parameter name with brackets",
      githubPassthrough,
      { location: "QUERY_PARAMETER", parameterName: "auth[token]" },
    ],
  ])("accepts %s", (_case, target, placement) => {
    expect(
      targetIssues({ ...target, outboundAuth: { ...apiKeyAuth, ...placement } }),
    ).toBeUndefined();
  });
  it.each([
    [
      "an unknown API key location",
      { location: "BODY" },
      ["outboundAuth", "location"],
      'Invalid option: expected one of "HEADER"|"QUERY_PARAMETER"',
    ],
    [
      "a parameterName over 64 characters",
      { parameterName: "x".repeat(65) },
      ["outboundAuth", "parameterName"],
      "Too big: expected string to have <=64 characters",
    ],
    [
      "a query parameter name over 64 characters",
      { location: "QUERY_PARAMETER", parameterName: "x".repeat(65) },
      ["outboundAuth", "parameterName"],
      "Too big: expected string to have <=64 characters",
    ],
    [
      "a HEADER parameterName with a colon",
      { location: "HEADER", parameterName: "Authorization: " },
      ["outboundAuth", "parameterName"],
      "A HEADER API key's parameterName must be an HTTP header name, with no spaces or colons.",
    ],
    [
      "a parameterName with spaces when location defaults to HEADER",
      { parameterName: "x api key" },
      ["outboundAuth", "parameterName"],
      "A HEADER API key's parameterName must be an HTTP header name, with no spaces or colons.",
    ],
    [
      "an empty API key prefix",
      { prefix: "" },
      ["outboundAuth", "prefix"],
      "Too small: expected string to have >=1 characters",
    ],
    [
      "an API key prefix over 64 characters",
      { prefix: "x".repeat(65) },
      ["outboundAuth", "prefix"],
      "Too big: expected string to have <=64 characters",
    ],
    [
      "QUERY_PARAMETER without a parameterName",
      { location: "QUERY_PARAMETER" },
      ["outboundAuth", "parameterName"],
      "An API key with location QUERY_PARAMETER requires a parameterName.",
    ],
  ])("rejects %s", (_case, placement, path, message) => {
    expect(
      targetIssues({ ...githubPassthrough, outboundAuth: { ...apiKeyAuth, ...placement } }),
    ).toEqual([{ path, message }]);
  });
  it.each([
    ["no outbound auth", {}],
    ["outbound auth NONE", { outboundAuth: { type: "NONE" } }],
  ])("accepts a passthrough target with %s", (_case, fields) => {
    expect(targetIssues({ ...githubPassthrough, ...fields })).toBeUndefined();
  });
  it.each([
    [
      "GATEWAY_IAM_ROLE with no service",
      { type: "GATEWAY_IAM_ROLE" },
      ["outboundAuth", "service"],
      "GATEWAY_IAM_ROLE outbound auth on passthrough targets requires a service name.",
    ],
    [
      "API_KEY with no credentialName",
      { type: "API_KEY" },
      ["outboundAuth", "credentialName"],
      "API_KEY outbound auth requires a credentialName.",
    ],
    [
      "OAUTH with no credentialName",
      { type: "OAUTH" },
      ["outboundAuth", "credentialName"],
      "OAUTH outbound auth requires a credentialName.",
    ],
    [
      "NONE with a service",
      { type: "NONE", service: "bedrock" },
      ["outboundAuth"],
      "service and region are only valid with GATEWAY_IAM_ROLE outbound auth.",
    ],
  ])("still rejects a passthrough target with %s", (_case, outboundAuth, path, message) => {
    expect(targetIssues({ ...githubPassthrough, outboundAuth })).toEqual([{ path, message }]);
  });
  it("rejects API key placement fields with non-API_KEY outbound auth", () => {
    expect(
      targetIssues({
        ...githubPassthrough,
        outboundAuth: {
          type: "OAUTH",
          credentialName: "githubOauth",
          parameterName: "Authorization",
        },
      }),
    ).toEqual([
      {
        path: ["outboundAuth"],
        message: "location, parameterName and prefix are only valid with API_KEY outbound auth.",
      },
    ]);
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
  it("allows HTTP targets only when protocolType is None", () => {
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
    expect(
      AgentCoreGatewaySchema.safeParse({
        name: "gateway",
        protocolType: "MCP",
        targets: [target],
      }).success,
    ).toBe(false);
  });

  it("rejects additionalPolicies beside an imported execution role", () => {
    const gateway = { name: "gateway", targets: [], additionalPolicies: ["policy.json"] };

    expect(AgentCoreGatewaySchema.safeParse(gateway).success).toBe(true);
    const imported = AgentCoreGatewaySchema.safeParse({
      ...gateway,
      executionRoleArn: "arn:aws:iam::123456789012:role/mine",
    });
    expect(imported.success).toBe(false);
    expect(imported.error?.issues[0]?.path).toEqual(["additionalPolicies"]);
  });
});
