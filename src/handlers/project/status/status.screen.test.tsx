import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetAgentRuntimeResponse,
  GetHarnessResponse,
  GetMemoryOutput,
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
import type { Project, ResolvedProjectResource } from "../types";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

afterEach(cleanupScreens);
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// The target region differs from the base context's us-east-1 on purpose: the
// detail screens must fetch where the project deployed, not in the ambient
// region.
const TARGET = { name: "default", account: "111122223333", region: "eu-west-1" } as const;
const ARN = `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}`;
const RUNTIME_ID = "checkout-AbCdEf1234";
const MEMORY_ID = "recallMemory-XyZ123";
const HARNESS_ID = "support-AbCdEf1234";

function project(spec: Record<string, unknown>): Project {
  return {
    name: "orders",
    rootPath: "/tmp/orders",
    spec: ProjectSpecSchema.parse({ name: "orders", version: 1, ...spec }),
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
  id: string,
  children?: ResolvedProjectResource[],
): ResolvedProjectResource => ({
  resourceType,
  name,
  ...(children ? { children } : {}),
  deploymentState: "deployed",
  id,
});

const localOnly = (
  resourceType: ResolvedProjectResource["resourceType"],
  name: string,
): ResolvedProjectResource => ({ resourceType, name, deploymentState: "local-only" });

const RUNTIME_RESOURCES: ResolvedProjectResource[] = [
  deployed("runtime", "checkout", `${ARN}:runtime/${RUNTIME_ID}`),
  deployed("memory", "recall", `${ARN}:memory/${MEMORY_ID}`),
];

function core(resources: ResolvedProjectResource[] = RUNTIME_RESOURCES): TestCoreClient {
  const value = new TestCoreClient();
  value.projectManager.resolveProjectResources = async () => ({ resources, target: TARGET });
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

function renderStatus(value: TestCoreClient, seed: Project = RUNTIME_PROJECT) {
  return renderScreen("/agentcore/project/status", {
    core: value,
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
        deployed("gateway", "tools", `${ARN}:gateway/tools-GwId12345`, [
          deployed("gateway-target", "search", "TARGETID123"),
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
        deployed("runtime", "checkout", `${ARN}:runtime/${RUNTIME_ID}`),
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
      core([deployed("harness", "support", `${ARN}:harness/${HARNESS_ID}`)]),
      project({ harnesses: [{ name: "support", path: "app/support" }] }),
    );

    await waitForGroup(screen, "support");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "agentcore → harness → get → " + HARNESS_ID);
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
      core([...RUNTIME_RESOURCES, deployed("credential", "svc-key", `${ARN}:token-vault/default`)]),
    );

    await waitForGroup(screen);
    // group → runtime → memory → project group → credential.
    for (let press = 0; press < 4; press++) await screen.press("down");
    expect(focusedLine(screen.lastFrame())).toContain("credential");
    await screen.press("return");

    await waitForText(screen.lastFrame, "credential svc-key has no detail view.");
    expect(screen.lastFrame()).toContain("agentcore → project → status");
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

  test("esc returns to the project command menu", async () => {
    const screen = renderStatus(core());

    await waitForGroup(screen);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage an AgentCore project");
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
    await waitForText(screen.lastFrame, "manage an AgentCore project");
  });

  test("an empty project reports that nothing is declared", async () => {
    const screen = renderStatus(core([]), project({}));

    await waitForText(screen.lastFrame, "No resources are declared in this project.");
  });

  test("reports the CLI's own guidance outside a project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-status-no-project-"));
    tempDirectories.push(directory);
    process.chdir(directory);
    const screen = renderScreen("/agentcore/project/status", { core: core() });

    await waitForFlatText(screen.lastFrame, "No AgentCore project found");
    expect(flatFrame(screen.lastFrame)).toContain("agentcore project create");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage an AgentCore project");
  });
});
