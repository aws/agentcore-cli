import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
  GetHarnessResponse,
  GetMemoryOutput,
  ListAgentRuntimeEndpointsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from "../../../globalConfig";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import {
  cleanupScreens,
  flatFrame,
  inTempDirectory,
  IMPERATIVE_GLOBAL_CONFIG,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForFlatText,
  waitForText,
} from "../../../testing";
import type { Project, ResolvedProjectResource } from "../types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(cleanupScreens);
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

// The target regions differ from the base context's us-east-1 on purpose, so
// the detail screens have to fetch where the project deployed.
const TARGET = { name: "default", account: "111122223333", region: "eu-west-1" } as const;
const STAGING = { name: "staging", account: "444455556666", region: "eu-central-1" } as const;
const ARN = `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}`;
const RUNTIME_ID = "checkout-AbCdEf1234";
const MEMORY_ID = "recallMemory-XyZ123";
const HARNESS_ID = "support-AbCdEf1234";

function project(spec: Record<string, unknown>): Project {
  return {
    name: "orders",
    rootPath: "/tmp/orders",
    spec: ProjectSpecSchema.parse({ name: "orders", version: 2, ...spec }),
  };
}

const RUNTIME_PROJECT = project({
  runtimes: [
    {
      name: "checkout",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/checkout",
      runtimeVersion: "PYTHON_3_14",
    },
  ],
  memories: [{ name: "recall", eventExpiryDuration: 30 }],
});

const deployed = (
  resourceType: ResolvedProjectResource["resourceType"],
  name: string,
  identifier: { arn: string } | { id: string },
  children?: ResolvedProjectResource[],
): ResolvedProjectResource => ({
  resourceType,
  name,
  ...(children ? { children } : {}),
  deploymentState: "deployed",
  ...identifier,
});

const localOnly = (
  resourceType: ResolvedProjectResource["resourceType"],
  name: string,
): ResolvedProjectResource => ({ resourceType, name, deploymentState: "local-only" });

const RUNTIME_RESOURCES: ResolvedProjectResource[] = [
  deployed("runtime", "checkout", { arn: `${ARN}:runtime/${RUNTIME_ID}` }),
  deployed("memory", "recall", { arn: `${ARN}:memory/${MEMORY_ID}` }),
];

// The fake resolves the requested target by name, so a screen that names the
// target it shows proves the name reached the manager call.
function core(
  resources: ResolvedProjectResource[] = RUNTIME_RESOURCES,
  targets: AwsDeploymentTarget[] = [TARGET],
): TestCoreClient {
  const value = new TestCoreClient();
  value.projectManager.listTargets = async () => targets;
  value.projectManager.resolveProjectResources = async (_project, { target }) => ({
    resources,
    target: targets.find((candidate) => candidate.name === target)!,
  });
  value.runtime.setGetResponse({
    agentRuntimeId: RUNTIME_ID,
    agentRuntimeArn: `${ARN}:runtime/${RUNTIME_ID}`,
    status: "READY",
  } as GetAgentRuntimeResponse);
  value.memory.setGetResponse({
    memory: { id: MEMORY_ID, name: "recall", arn: `${ARN}:memory/${MEMORY_ID}`, status: "ACTIVE" },
  } as GetMemoryOutput);
  value.harness.setGetResponse({
    harness: { harnessId: HARNESS_ID, harnessName: "support", arn: `${ARN}:harness/${HARNESS_ID}` },
  } as GetHarnessResponse);
  return value;
}

function renderStatus(
  value: TestCoreClient,
  seed: Project = RUNTIME_PROJECT,
  globalConfig: GlobalConfig = DEFAULT_GLOBAL_CONFIG,
) {
  return renderScreen("/agentcore/status", {
    core: value,
    globalConfig,
    withContext: (ctx) => ctx.withValue(ProjectKey, seed),
  });
}

// waitForGroup waits for the tree to be up: the agent group row is the first
// thing only a resolved status renders (the description mentions resources
// while loading too).
function waitForGroup(screen: ReturnType<typeof renderStatus>, name = "checkout") {
  return waitForFlatText(screen.lastFrame, `${name} agent`);
}

// focusedLine returns the line carrying the ❯ marker.
function focusedLine(frame: string | undefined): string {
  return (frame ?? "").split("\n").find((line) => line.includes("❯")) ?? "";
}

describe("project status screen", () => {
  test("groups the runtime agent's Runtime and Memory beneath it", async () => {
    const screen = renderStatus(core());

    await waitForGroup(screen);
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain("checkout agent");
    expect(frame).toMatch(/runtime\s+checkout deployed/);
    expect(frame).toMatch(/memory\s+recall deployed/);
    // Both resources are attributed to the agent — no shared group appears.
    expect(frame).not.toContain("project shared resources");
  });

  test("keeps unattributable resources visible under a shared project group", async () => {
    const screen = renderStatus(
      core([
        ...RUNTIME_RESOURCES,
        deployed("gateway", "tools", { arn: `${ARN}:gateway/tools-GwId12345` }, [
          deployed("gateway-target", "search", { id: "TARGETID123" }),
        ]),
        localOnly("credential", "svc-key"),
      ]),
    );

    await waitForGroup(screen);
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain("project shared resources");
    expect(frame).toMatch(/gateway\s+tools deployed/);
    expect(frame).toMatch(/gateway-target\s+search deployed/);
    expect(frame).toMatch(/credential\s+svc-key local-only/);
  });

  test("marks declared-but-undeployed rows local-only and skips them when navigating", async () => {
    const screen = renderStatus(
      core([
        deployed("runtime", "checkout", { arn: `${ARN}:runtime/${RUNTIME_ID}` }),
        localOnly("memory", "recall"),
      ]),
    );

    await waitForText(screen.lastFrame, "local-only");
    // Down from the agent group focuses the Runtime; the disabled Memory row
    // cannot take focus, so a second press leaves the focus where it is.
    await screen.press("down");
    expect(focusedLine(screen.lastFrame())).toContain("runtime");
    await screen.press("down");
    expect(focusedLine(screen.lastFrame())).toContain("runtime");
  });

  test("enter on the Runtime opens the Runtime detail page in the target region", async () => {
    const value = core();
    const screen = renderStatus(value);

    await waitForGroup(screen);
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "agentcore → runtime → get → " + RUNTIME_ID);
    await waitForText(screen.lastFrame, "READY");
    const call = value.runtime.calls.find(({ method }) => method === "getRuntime")!;
    expect(call.args[0]).toBe(RUNTIME_ID);
    expect(call.args[1]).toMatchObject({ region: TARGET.region });
  });

  test("enter on the Memory opens the Memory detail page in the target region", async () => {
    const value = core();
    const screen = renderStatus(value);

    await waitForGroup(screen);
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "agentcore → memory → get → " + MEMORY_ID);
    await waitForText(screen.lastFrame, "ACTIVE");
    const call = value.memory.calls.find(({ method }) => method === "getMemory")!;
    expect(call.args[0]).toBe(MEMORY_ID);
    expect(call.args[2]).toMatchObject({ region: TARGET.region });
  });

  test("enter on a Harness opens the Harness detail page", async () => {
    const screen = renderStatus(
      core([deployed("harness", "support", { arn: `${ARN}:harness/${HARNESS_ID}` })]),
      project({ harnesses: [{ name: "support", path: "app/support" }] }),
    );

    await waitForGroup(screen, "support");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "agentcore → harness → get → " + HARNESS_ID);
  });

  test.each([false, true])(
    "Harness actions from project status respect imperative-commands=%s",
    async (enabled) => {
      const value = core([deployed("harness", "support", { arn: `${ARN}:harness/${HARNESS_ID}` })]);
      const screen = renderStatus(
        value,
        project({ harnesses: [{ name: "support", path: "app/support" }] }),
        enabled ? IMPERATIVE_GLOBAL_CONFIG : DEFAULT_GLOBAL_CONFIG,
      );
      await waitForGroup(screen, "support");
      await screen.press("down");
      await screen.press("return");
      await waitForText(screen.lastFrame, "show the full JSON definition");

      const frame = flatFrame(screen.lastFrame);
      for (const description of [
        "update this harness",
        "chat with this harness",
        "run shell commands in this harness",
      ]) {
        if (enabled) expect(frame).toContain(description);
        else expect(frame).not.toContain(description);
      }
      expect(frame).toContain("list this harness's endpoints");
      expect(frame).toContain("list this harness's versions");
      if (enabled) {
        for (let press = 0; press < 5; press++) await screen.press("down");
        expect(focusedLine(screen.lastFrame())).toContain("update");
        await screen.press("return");
        await waitForText(screen.lastFrame, "choose a model");
        expect(flatFrame(screen.lastFrame)).toContain("harness → update");
      } else {
        await screen.press("return");
        await waitForText(screen.lastFrame, '"harnessId"');
      }
      expect(value.harness.calls.every(({ method }) => method === "getHarness")).toBe(true);
    },
  );

  test("disabled Runtime execution leaves endpoint and JSON navigation available", async () => {
    const value = core();
    value.runtime.setListEndpointsResponse({
      runtimeEndpoints: [
        {
          name: "delete",
          status: "READY",
          agentRuntimeEndpointArn: `${ARN}:runtime/${RUNTIME_ID}/runtime-endpoint/delete`,
        },
      ],
    } as ListAgentRuntimeEndpointsResponse);
    value.runtime.setGetEndpointResponse({
      name: "delete",
      status: "READY",
      liveVersion: "1",
    } as GetAgentRuntimeEndpointResponse);
    const screen = renderStatus(value);

    await waitForGroup(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "READY");
    expect(flatFrame(screen.lastFrame)).not.toContain("invoke this Runtime");
    expect(flatFrame(screen.lastFrame)).not.toContain("open an interactive terminal");
    expect(focusedLine(screen.lastFrame())).toContain("endpoints");
    await screen.press("return");
    await waitForText(screen.lastFrame, "delete");
    await screen.press("return");
    await waitForText(screen.lastFrame, "liveVersion");
    expect(flatFrame(screen.lastFrame)).not.toContain("invoke this Runtime endpoint");
    expect(focusedLine(screen.lastFrame())).toContain("detail");
    await screen.press("return");
    await waitForText(screen.lastFrame, '"liveVersion"');
    expect(value.runtime.calls.every(({ method }) => /^(get|list)/.test(method))).toBe(true);
    const call = value.runtime.calls.find(({ method }) => method === "getRuntimeEndpoint")!;
    expect(call.args).toEqual([
      RUNTIME_ID,
      "delete",
      expect.objectContaining({ region: TARGET.region }),
    ]);
  });

  test("escape from a detail page returns to the status screen", async () => {
    const screen = renderStatus(core());

    await waitForGroup(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → runtime → get");

    await screen.press("escape");
    await waitForGroup(screen);
  });

  test("a deployed resource without a detail screen explains itself instead of navigating", async () => {
    const screen = renderStatus(
      core([
        ...RUNTIME_RESOURCES,
        deployed("credential", "svc-key", { arn: `${ARN}:token-vault/default` }),
      ]),
    );

    await waitForGroup(screen);
    // group → runtime → memory → project group → credential.
    for (let press = 0; press < 4; press++) await screen.press("down");
    expect(focusedLine(screen.lastFrame())).toContain("credential");
    await screen.press("return");

    await waitForText(screen.lastFrame, "credential svc-key has no detail view.");
    expect(screen.lastFrame()).toContain("agentcore → status");
  });

  test("left and right arrows collapse and expand an agent group", async () => {
    const screen = renderStatus(core());

    await waitForGroup(screen);
    expect(screen.lastFrame()).toContain("runtime");
    await screen.press("left");
    expect(screen.lastFrame()).not.toContain("runtime");
    await screen.press("right");
    await waitForText(screen.lastFrame, "runtime");
  });

  test("esc returns to the root command menu", async () => {
    const screen = renderStatus(core());

    await waitForGroup(screen);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
  });

  test("shows resolution errors with the standard treatment", async () => {
    const value = core();
    value.projectManager.resolveProjectResources = async () => {
      throw new Error("No deployment targets are configured for project 'orders'.");
    };
    const screen = renderStatus(value);

    await waitForText(screen.lastFrame, "No deployment targets are configured");
    expect(screen.lastFrame()).toContain("✗");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
  });

  test("an empty project reports that nothing is declared", async () => {
    const screen = renderStatus(core([]), project({}));

    await waitForText(screen.lastFrame, "No resources are declared in this project.");
  });

  test("the target's region stays pinned for what a detail page opens next", async () => {
    const value = core();
    const screen = renderStatus(value);

    await waitForGroup(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "READY");
    // With imperative commands off, endpoints is the first action.
    await screen.press("return");

    await waitForText(screen.lastFrame, "agentcore → runtime → endpoint → list → " + RUNTIME_ID);
    await waitFor(() =>
      value.runtime.calls.some(({ method }) => method === "listRuntimeEndpoints"),
    );
    const call = value.runtime.calls.find(({ method }) => method === "listRuntimeEndpoints")!;
    expect(call.args[3]).toMatchObject({ region: TARGET.region });
  });

  test("several targets: asks which, keeps the choice and its region across a detail page, esc returns to the choice, and a menu unpins", async () => {
    const value = core(RUNTIME_RESOURCES, [TARGET, STAGING]);
    const screen = renderStatus(value);

    await waitForText(screen.lastFrame, "choose a deployment target");
    const picker = flatFrame(screen.lastFrame);
    expect(picker).toContain(`default ${TARGET.account} ${TARGET.region}`);
    expect(picker).toContain(`staging ${STAGING.account} ${STAGING.region}`);
    await screen.press("down");
    await screen.press("return");

    await waitForGroup(screen);
    expect(screen.lastFrame()).toContain("on target staging");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → runtime → get");
    await waitForText(screen.lastFrame, "READY");
    const runtimeCall = value.runtime.calls.find(({ method }) => method === "getRuntime")!;
    expect(runtimeCall.args[1]).toMatchObject({ region: STAGING.region });
    await screen.press("escape");
    await waitForGroup(screen);
    expect(screen.lastFrame()).toContain("on target staging");
    expect(screen.lastFrame()).not.toContain("choose a deployment target");
    // Back on the tree the target's region is still pinned for the next open.
    await screen.press("down");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "ACTIVE");
    const memoryCall = value.memory.calls.find(({ method }) => method === "getMemory")!;
    expect(memoryCall.args[2]).toMatchObject({ region: STAGING.region });
    await screen.press("escape");
    await waitForGroup(screen);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a deployment target");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    // Past the screen that pinned, the menus and what they open fetch in the
    // launch region again.
    await screen.write("eval");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval");
    await screen.write("evaluator");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → evaluator");
    await screen.write("list");
    await screen.press("return");
    await waitFor(() => value.eval.calls.some(({ method }) => method === "listEvaluators"));
    const listCall = value.eval.calls.find(({ method }) => method === "listEvaluators")!;
    expect(listCall.args[2]).toMatchObject({ region: "us-east-1" });
  });

  test("reports the CLI's own guidance outside a project", async () => {
    cleanups.push((await inTempDirectory()).cleanup);
    const screen = renderScreen("/agentcore/status", { core: core() });

    await waitForFlatText(screen.lastFrame, "No AgentCore project found");
    expect(flatFrame(screen.lastFrame)).toContain("agentcore create");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "the platform for production AI agents");
  });
});
