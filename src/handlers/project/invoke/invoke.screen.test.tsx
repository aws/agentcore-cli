import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import { cleanupScreens, renderScreen, TestCoreClient, waitForText } from "../../../testing";
import type { DeployedProjectResource, Project } from "../types";

afterEach(cleanupScreens);

const project: Project = {
  name: "orders",
  rootPath: "/tmp/orders",
  spec: ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    runtimes: [
      {
        name: "checkout",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/checkout",
        runtimeVersion: "PYTHON_3_14",
      },
    ],
    harnesses: [{ name: "support", path: "app/support" }],
  }),
};

function endpoint(name: string): AgentRuntimeEndpoint {
  return {
    id: name,
    name,
    agentRuntimeEndpointArn: `arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime-endpoint/${name}`,
    agentRuntimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/runtime-123",
    createdAt: new Date(0),
    liveVersion: "1",
    targetVersion: "1",
    status: "READY",
    lastUpdatedAt: new Date(0),
  };
}

const TARGET = { name: "default", account: "111122223333", region: "eu-west-1" } as const;

const DEPLOYED_RESOURCES: DeployedProjectResource[] = [
  { resourceType: "runtime", name: "checkout", id: "runtime-123" },
  { resourceType: "harness", name: "support", id: "harness-123" },
];

function core(resources: DeployedProjectResource[] = DEPLOYED_RESOURCES): TestCoreClient {
  const value = new TestCoreClient();
  value.projectManager.resolveDeployedResource = async (_project, input) => ({
    id: input.resourceType === "runtime" ? "runtime-123" : "harness-123",
    target: TARGET,
  });
  value.projectManager.resolveDeployedResources = async () => ({ resources, target: TARGET });
  value.runtime
    .setListEndpointsResponse({ runtimeEndpoints: [endpoint("DEFAULT")] })
    .setGetResponse({
      agentRuntimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/runtime-123",
    } as GetAgentRuntimeResponse);
  value.harness.setGetResponse({
    harness: {
      harnessId: "harness-123",
      harnessName: "support",
      arn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/harness-123",
    },
  } as GetHarnessResponse);
  return value;
}

describe("project invoke picker", () => {
  test("lists only resources present in the deployed target", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core([{ resourceType: "harness", name: "support", id: "harness-123" }]),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "support");
    expect(screen.lastFrame()).not.toContain("checkout");
  });

  test("esc returns to the project command menu", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage an AgentCore project");
    expect(screen.lastFrame()).toContain("invoke");
  });

  test("shows deployment errors without listing configured resources", async () => {
    const value = core();
    value.projectManager.resolveDeployedResources = async () => {
      throw new Error("No deployment targets are configured for project 'orders'.");
    };
    const screen = renderScreen("/agentcore/project/invoke", {
      core: value,
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "No deployment targets are configured");
    expect(screen.lastFrame()).not.toContain("checkout");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage an AgentCore project");
  });

  test("resolves the enclosing project when opened from the project menu", async () => {
    const value = core();
    value.projectManager.resolve = async () => project;
    const screen = renderScreen("/agentcore/project/invoke", { core: value });

    await waitForText(screen.lastFrame, "checkout");
    expect(screen.lastFrame()).toContain("support");
  });

  test("lists project Runtime and Harness resources", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    expect(screen.lastFrame()).toContain("Runtime");
    expect(screen.lastFrame()).toContain("HTTP");
    expect(screen.lastFrame()).toContain("app/checkout");
    expect(screen.lastFrame()).toContain("support");
    expect(screen.lastFrame()).toContain("Harness");
    expect(screen.lastFrame()).toContain("app/support");
  });

  test("opens the selected Harness chat in the same TUI", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "send a message…");
    expect(screen.lastFrame()).toContain("harness-123");
  });

  test("uses the existing Runtime endpoint picker before its JSON console", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Enter JSON payload");
    expect(screen.lastFrame()).not.toContain("Enter prompt");
  });
});
