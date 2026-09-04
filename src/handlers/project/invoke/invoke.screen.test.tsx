import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import {
  cleanupScreens,
  flatFrame,
  renderScreen,
  TestCoreClient,
  waitForFlatText,
  waitForText,
} from "../../../testing";
import type { Project, ResolvedDeployedResource } from "../types";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

afterEach(cleanupScreens);
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

const DEPLOYED_RESOURCES: ResolvedDeployedResource[] = [
  { resourceType: "runtime", name: "checkout", id: "runtime-123", target: TARGET },
  { resourceType: "harness", name: "support", id: "harness-123", target: TARGET },
];

function core(resources: ResolvedDeployedResource[] = DEPLOYED_RESOURCES): TestCoreClient {
  const value = new TestCoreClient();
  value.projectManager.resolveDeployedResource = async (_project, input) => ({
    resourceType: input.resourceType,
    name: input.name,
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
      core: core([{ resourceType: "harness", name: "support", id: "harness-123", target: TARGET }]),
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

  test("reports the CLI's own guidance outside a project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
    tempDirectories.push(directory);
    process.chdir(directory);
    const screen = renderScreen("/agentcore/project/invoke", { core: core() });

    await waitForFlatText(screen.lastFrame, "No AgentCore project found");
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain(directory);
    expect(frame).toContain("agentcore project create");
    expect(frame).not.toContain("Resolving project");
    // esc is a way off the error, not just ctrl+c.
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
