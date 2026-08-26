import { describe, expect, test } from "bun:test";
import type { Project } from "../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { handleResources } from "./resources";
import { fakeSupervisor } from "./testkit";
import type { InspectorDeps } from "./types";

function deps(overrides: Partial<InspectorDeps> = {}): InspectorDeps {
  return { supervisor: fakeSupervisor(), ...overrides };
}

function project(): Project {
  return {
    name: "Demo",
    rootPath: "/workspace/demo",
    spec: ProjectSpecSchema.parse({
      name: "Demo",
      version: 1,
      managedBy: "CDK",
      runtimes: [
        {
          name: "orders",
          build: "Container",
          entrypoint: "index.ts",
          codeLocation: "src",
          envVars: [{ name: "STAGE", value: "dev" }],
        },
      ],
      harnesses: [{ name: "support", path: "harness/support" }],
      memories: [
        {
          name: "chat",
          eventExpiryDuration: 30,
          strategies: [{ type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] }],
        },
      ],
      credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "stripe-key" }],
      evaluators: [
        {
          name: "quality",
          level: "SESSION",
          description: "Checks quality",
          config: {
            llmAsAJudge: {
              model: "anthropic.claude-v2",
              instructions: "Judge the answer",
              ratingScale: { numerical: [{ value: 1, label: "bad", definition: "Bad answer" }] },
            },
          },
        },
      ],
      onlineEvalConfigs: [
        { name: "prod_eval", agent: "orders", samplingRate: 10, evaluators: ["quality"] },
      ],
      agentCoreGateways: [
        {
          name: "gw",
          targets: [
            {
              name: "orders-target",
              targetType: "lambda",
              toolDefinitions: [
                {
                  name: "lookup",
                  description: "Look up an order",
                  inputSchema: { type: "object" },
                },
              ],
              compute: {
                host: "Lambda",
                implementation: { language: "Python", path: "tools", handler: "handler.main" },
                pythonVersion: "PYTHON_3_12",
              },
            },
          ],
        },
      ],
      mcpRuntimeTools: [
        {
          name: "search-tool",
          toolDefinition: {
            name: "search",
            description: "Search the catalog",
            inputSchema: { type: "object" },
          },
          compute: {
            host: "AgentCoreRuntime",
            implementation: { language: "Python", path: "tools", handler: "handler.main" },
          },
          bindings: [{ runtimeName: "orders", envVarName: "SEARCH_URL" }],
        },
      ],
      unassignedTargets: [
        {
          name: "catalog",
          targetType: "smithyModel",
          schemaSource: { inline: { path: "schema.smithy" } },
        },
      ],
      policyEngines: [
        {
          name: "guardrails",
          description: "Access policies",
          policies: [
            {
              name: "allow_read",
              description: "Allow reads",
              statement: "permit(principal, action, resource);",
            },
          ],
        },
      ],
    }),
  };
}

describe("GET /api/resources", () => {
  test("flattens the project spec into the resource graph", () => {
    const response = handleResources(deps({ project: project() }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({
      success: true,
      project: "Demo",
      agents: [
        {
          name: "orders",
          build: "Container",
          entrypoint: "index.ts",
          codeLocation: "src",
          runtimeVersion: "",
          networkMode: "PUBLIC",
          protocol: "HTTP",
          envVars: ["STAGE"],
        },
      ],
      harnesses: [{ name: "support", model: "", tools: [] }],
      memories: [
        {
          name: "chat",
          strategies: [{ type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] }],
          expiryDays: 30,
        },
      ],
      credentials: [{ name: "stripe-key", type: "ApiKeyCredentialProvider" }],
      gateways: [{ name: "gw", targets: [{ name: "lookup", targetType: "lambda" }] }],
      mcpRuntimeTools: [
        { name: "search-tool", bindings: [{ runtimeName: "orders", envVarName: "SEARCH_URL" }] },
      ],
      evaluators: [
        {
          name: "quality",
          level: "SESSION",
          description: "Checks quality",
          configType: "llm-as-a-judge",
        },
      ],
      onlineEvalConfigs: [
        { name: "prod_eval", agent: "orders", evaluators: ["quality"], samplingRate: 10 },
      ],
      policyEngines: [
        {
          name: "guardrails",
          description: "Access policies",
          policies: [{ name: "allow_read", description: "Allow reads" }],
        },
      ],
      unassignedTargets: [{ name: "catalog", targetType: "smithyModel" }],
      deploymentTargets: [],
    });
  });

  test("returns 404 when there is no project", () => {
    const response = handleResources(deps());
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body as string)).toEqual({
      success: false,
      error: "No agentcore project found",
    });
  });
});
