import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
  GetGatewayResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import { DEFAULT_GLOBAL_CONFIG } from "../../../globalConfig";
import { createRootHandler } from "../../index";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  inTempDirectory,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  tick,
  ttyTestIO,
  waitFor,
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
    version: 2,
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
    agentCoreGateways: [{ name: "tools", targets: [] }],
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
  {
    resourceType: "gateway",
    name: "tools",
    id: "gateway-123",
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
  value.gateway.setGetResponse({
    gatewayId: "gateway-123",
    gatewayUrl: "https://gateway-123.gateway.example.test/mcp",
    authorizerType: "NONE",
    status: "READY",
  } as GetGatewayResponse);
  return value;
}

describe("project invoke picker", () => {
  test.each(["harness", "runtime"] as const)(
    "the public %s CLI command opens and invokes through the TUI with the flag off",
    async (family) => {
      const value = core();
      value.projectManager.resolve = async () => project;
      const { streams, stdin } = ttyTestIO();
      const root = createRootHandler(value, {
        io: streams.io,
        logger: createSilentLogger(),
        globalConfigAccessor: new TestGlobalConfigAccessor({
          initialConfigData: DEFAULT_GLOBAL_CONFIG,
        }),
        globalConfig: DEFAULT_GLOBAL_CONFIG,
      });
      const rendering = root.route([
        "node",
        "agentcore",
        "invoke",
        family,
        "--name",
        family === "runtime" ? "checkout" : "support",
        "--qualifier",
        "DEFAULT",
        "--region",
        TARGET.region,
      ]);
      try {
        await waitFor(() =>
          streams.stdout().includes(family === "harness" ? "send a message" : "Enter JSON payload"),
        );
        expect(streams.stdout()).not.toContain("exec mode");
        stdin.write(family === "harness" ? "hello" : '{"prompt":"hello"}');
        await tick();
        stdin.write("\r");
        const method = family === "harness" ? "invokeHarness" : "invokeRuntime";
        await waitFor(() => value[family].calls.some((call) => call.method === method));
        expect(
          value.harness.calls.some((call) => call.method === "invokeAgentRuntimeCommand"),
        ).toBe(false);
      } finally {
        stdin.write("\x03");
        await rendering;
      }
    },
  );

  test("lists only resources present in the deployed target", async () => {
    const screen = renderScreen("/agentcore/invoke", {
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

  test("esc returns to the root command menu", async () => {
    const screen = renderScreen("/agentcore/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expect(screen.lastFrame()).toContain("invoke");
  });

  test("several targets: asks which, then invokes on the chosen one in its region", async () => {
    const value = core(DEPLOYED_RESOURCES, [TARGET, STAGING]);
    let requested: string | undefined;
    value.projectManager.resolveDeployedResources = async (_project, { target }) => {
      requested = target;
      return { resources: DEPLOYED_RESOURCES, target: STAGING };
    };
    const screen = renderScreen("/agentcore/invoke", {
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
    const screen = renderScreen("/agentcore/invoke", {
      core: value,
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "No deployment targets are configured");
    expect(screen.lastFrame()).not.toContain("checkout");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
  });

  test("reports the CLI's own guidance outside a project", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const screen = renderScreen("/agentcore/invoke", { core: core() });

    await waitForFlatText(screen.lastFrame, "No AgentCore project found");
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain(directory);
    expect(frame).toContain("agentcore create");
    expect(frame).not.toContain("Resolving project");
    // esc is a way off the error, not just ctrl+c.
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
  });

  test("resolves the enclosing project when opened from the root menu", async () => {
    const value = core();
    value.projectManager.resolve = async () => project;
    const screen = renderScreen("/agentcore/invoke", { core: value });

    await waitForText(screen.lastFrame, "checkout");
    expect(screen.lastFrame()).toContain("support");
  });

  test("lists project Runtime, Harness, and Gateway resources", async () => {
    const screen = renderScreen("/agentcore/invoke", {
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
    expect(screen.lastFrame()).toContain("tools");
    expect(screen.lastFrame()).toContain("Gateway");
  });

  test("opens the selected Gateway console with the target's credentials", async () => {
    const value = core();
    const screen = renderScreen("/agentcore/invoke", {
      core: value,
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "gateway-123");
    expect(value.gateway.calls.find(({ method }) => method === "getGateway")?.args[1]).toEqual({
      region: TARGET.region,
      endpointUrl: undefined,
      credentials: TARGET_CREDENTIALS,
    });
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a project resource to invoke");
  });

  test("opens the selected Harness chat in the same TUI", async () => {
    const value = core();
    const screen = renderScreen("/agentcore/invoke", {
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

  test("project Runtime invocation keeps target switching within the selected resource", async () => {
    const value = core();
    const screen = renderScreen("/agentcore/invoke", {
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
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "choose another endpoint");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "Enter JSON payload");
    await screen.write("{}");
    await screen.press("return");
    await waitFor(() => value.runtime.calls.some((call) => call.method === "invokeRuntime"));
    expect(
      value.runtime.calls.find((call) => call.method === "invokeRuntime")!.args[0],
    ).toMatchObject({ runtimeId: "runtime-123", qualifier: "DEFAULT" });
    expect(value.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
  });
});
