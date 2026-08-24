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
      gateways: [],
      mcpRuntimeTools: [],
      evaluators: [],
      onlineEvalConfigs: [],
      policyEngines: [],
      unassignedTargets: [],
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
