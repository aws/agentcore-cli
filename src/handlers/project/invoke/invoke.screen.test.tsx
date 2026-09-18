import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import {
  cleanupScreens,
  flatFrame,
  inTempDirectory,
  renderScreen,
  TestCoreClient,
  waitForFlatText,
  waitForText,
} from "../../../testing";
import type { Project, ResolvedDeployedResource } from "../types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(cleanupScreens);
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

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

// The target regions differ from the base context's us-east-1 on purpose, so
// the invoke flows have to fetch where the project deployed.
const TARGET = { name: "default", account: "111122223333", region: "eu-west-1" } as const;
const STAGING = { name: "staging", account: "444455556666", region: "eu-central-1" } as const;
const TARGET_CREDENTIALS = async () => ({
  accessKeyId: "target-access-key",
  secretAccessKey: "target-secret-key",
});

const DEPLOYED_RESOURCES: ResolvedDeployedResource[] = [
  {
    resourceType: "runtime",
    name: "checkout",
    id: "runtime-123",
    target: TARGET,
    credentialProvider: TARGET_CREDENTIALS,
  },
  {
    resourceType: "harness",
    name: "support",
    id: "harness-123",
    target: TARGET,
    credentialProvider: TARGET_CREDENTIALS,
  },
];

function core(
  resources: ResolvedDeployedResource[] = DEPLOYED_RESOURCES,
  targets: AwsDeploymentTarget[] = [TARGET],
): TestCoreClient {
  const value = new TestCoreClient();
  value.projectManager.listTargets = async () => targets;
  value.projectManager.resolveDeployedResource = async (_project, input) => ({
    resourceType: input.resourceType,
    name: input.name,
    id: input.resourceType === "runtime" ? "runtime-123" : "harness-123",
    target: TARGET,
    credentialProvider: TARGET_CREDENTIALS,
  });
  value.projectManager.resolveDeployedResources = async (_project, { target }) => ({
    resources,
    target: targets.find((candidate) => candidate.name === target)!,
  });
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
      core: core([
        {
          resourceType: "harness",
          name: "support",
          id: "harness-123",
          target: TARGET,
          credentialProvider: TARGET_CREDENTIALS,
        },
      ]),
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

  test("several targets: asks which, then invokes on the chosen one in its region", async () => {
    const value = core(DEPLOYED_RESOURCES, [TARGET, STAGING]);
    let requested: string | undefined;
    value.projectManager.resolveDeployedResources = async (_project, { target }) => {
      requested = target;
      return { resources: DEPLOYED_RESOURCES, target: STAGING };
    };
    const screen = renderScreen("/agentcore/project/invoke", {
      core: value,
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "choose a deployment target");
    expect(flatFrame(screen.lastFrame)).toContain(`staging ${STAGING.account} ${STAGING.region}`);
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "checkout");
    expect(requested).toBe("staging");
    expect(screen.lastFrame()).toContain("on target staging");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "send a message…");
    expect(
      value.harness.calls.find(({ method }) => method === "getHarness")?.args[1],
    ).toMatchObject({ region: STAGING.region });
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
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
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
    const value = core();
    const screen = renderScreen("/agentcore/project/invoke", {
      core: value,
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "send a message…");
    expect(screen.lastFrame()).toContain("harness-123");
    expect(value.harness.calls.find(({ method }) => method === "getHarness")?.args[1]).toEqual({
      region: TARGET.region,
      endpointUrl: undefined,
      credentials: TARGET_CREDENTIALS,
    });
  });

  test("uses the existing Runtime endpoint picker before its JSON console", async () => {
    const value = core();
    const screen = renderScreen("/agentcore/project/invoke", {
      core: value,
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Enter JSON payload");
    expect(screen.lastFrame()).not.toContain("Enter prompt");
    expect(
      value.runtime.calls.find(({ method }) => method === "listRuntimeEndpoints")?.args[3],
    ).toEqual({
      region: TARGET.region,
      endpointUrl: undefined,
      credentials: TARGET_CREDENTIALS,
    });
  });
});
