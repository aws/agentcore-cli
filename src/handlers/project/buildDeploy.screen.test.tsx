import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeployBackendInput, ProjectBackend } from "../../core/project";
import { createRootHandler } from "../index";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  waitForFlatText,
  waitForText,
} from "../../testing";
import type { DeployResult, Project, ProjectEvent } from "./types";

// The build and deploy screens run the same ProjectManager generators the
// commands run, so these tests stub the backend exactly as the handler tests
// do and assert the same steps come out — through the TaskList this time.

const EVENTS: ProjectEvent[] = [
  { type: "step", message: "Synthesizing CloudFormation templates" },
  { type: "output", line: "cdk synth: 3 stacks" },
  { type: "step", message: "Deploying stack" },
  { type: "output", line: "CREATE_IN_PROGRESS | AWS::IAM::Role" },
];

type FakeBackendOptions = {
  events?: ProjectEvent[];
  failure?: Error;
  result?: DeployResult;
};

function fakeBackend(options: FakeBackendOptions = {}) {
  const deploys: { project: Project; input: DeployBackendInput; confirmed?: boolean }[] = [];
  const backend: ProjectBackend = {
    async *build() {
      yield* options.events ?? EVENTS;
      if (options.failure) throw options.failure;
    },
    async *deploy(project, input) {
      const call: (typeof deploys)[number] = { project, input };
      deploys.push(call);
      call.confirmed = await input.confirmTeardown({
        projectName: project.name,
        targetName: input.target.name,
        resourceDescription: "the stack",
        account: input.target.account,
        region: input.target.region,
      });
      yield* options.events ?? EVENTS;
      if (options.failure) throw options.failure;
      return options.result ?? { outputs: { RuntimeArn: "arn:runtime" } };
    },
    async resolveProjectResources() {
      return [];
    },
    async resolveDeployedResources() {
      return [];
    },
  };
  return { backend, deploys };
}

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

afterEach(cleanupScreens);
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds project 'orders' with a default target and cds into it. */
const STAGING = { name: "staging", account: "444455556666", region: "eu-west-1" } as const;

async function inProject(
  core: TestCoreClient,
  options: { empty?: boolean; targets?: boolean; staging?: boolean } = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-build-deploy-screen-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  const root = createRootHandler(core, {
    io: testIO().io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route([
    "node",
    "agentcore",
    "project",
    "create",
    "--name",
    "orders",
    "--skip-install",
    "--skip-git",
  ]);
  const projectRoot = join(process.cwd(), "orders");
  if (options.targets !== false) {
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([
        { name: "default", account: "111122223333", region: "us-east-1" },
        ...(options.staging ? [STAGING] : []),
      ]),
    );
  }
  if (options.empty) {
    // What `remove --all` leaves: the up-front signal the deploy asks about.
    await writeFile(
      join(projectRoot, "agentcore", "agentcore.json"),
      JSON.stringify({ name: "orders", version: 1 }),
    );
  }
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project build screen", () => {
  test("starts at once, renders the backend's steps as the CLI does, then the CLI's own success line", async () => {
    const { backend } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/build", { core });

    // Both steps settle to ✓, as the inline TaskList leaves them on the
    // command line; the finished steps' output tails collapse.
    await waitForText(r.lastFrame, "✔ Built project 'orders'");
    const frame = r.lastFrame()!;
    expect(frame).toContain("agentcore → project → build");
    // No frame — not even the first — advertised a question.
    expect(r.frames.some((painted) => painted.includes("(y/N)") || painted.includes("y/n"))).toBe(
      false,
    );
    expect(frame).toContain("✓ Synthesizing CloudFormation templates");
    expect(frame).toContain("✓ Deploying stack");
    expect(frame).not.toContain("cdk synth");
    expect(frame).toContain("agentcore project deploy");

    // Enter stays in the TUI: back to the project menu.
    await r.press("return");
    await waitForText(r.lastFrame, "manage an AgentCore project");
    r.unmount();
  });

  test("a failing step is marked ✕ with its output kept, above the error", async () => {
    const { backend } = fakeBackend({ failure: new Error("synth exploded") });
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/build", { core });

    await waitForText(r.lastFrame, "✗ synth exploded");
    const frame = r.lastFrame()!;
    expect(frame).toContain("✓ Synthesizing CloudFormation templates");
    expect(frame).toContain("✕ Deploying stack");
    expect(frame).toContain("CREATE_IN_PROGRESS | AWS::IAM::Role");
    // With no confirmation to return to, esc leaves for the project menu
    // rather than running the build again.
    await r.press("escape");
    await waitForText(r.lastFrame, "manage an AgentCore project");
    r.unmount();
  });

  test("reports the CLI's own guidance outside a project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
    tempDirectories.push(directory);
    process.chdir(directory);
    const r = renderScreen("/agentcore/project/build");

    await waitForFlatText(r.lastFrame, "No AgentCore project found");
    expect(flatFrame(r.lastFrame)).toContain("agentcore project create");
    // esc is a way off the error, not just ctrl+c.
    await r.press("escape");
    await waitForText(r.lastFrame, "manage an AgentCore project");
    r.unmount();
  });
});

describe("project deploy screen", () => {
  test("one target: deploys to it at once, then the CLI's own success line", async () => {
    const { backend, deploys } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/deploy", { core });

    // A project with resources is not asked anything, as on the command line.
    await waitForText(r.lastFrame, "✔ Deployed project 'orders' to target 'default'");
    const frame = flatFrame(r.lastFrame);
    expect(frame).not.toContain("(y/N)");
    expect(frame).toContain("project orders");
    expect(frame).toContain("target default");
    expect(frame).toContain("✓ Synthesizing CloudFormation templates");
    expect(frame).toContain("✓ Deploying stack");
    // Stack outputs are not listed, as the command prints them only with --json.
    expect(frame).not.toContain("RuntimeArn");
    expect(frame).toContain("[enter] go back");

    // …and never confirms a teardown.
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.confirmed).toBe(false);
    expect(deploys[0]!.input.target.name).toBe("default");
    r.unmount();
  });

  test("a target-loading failure offers esc back and r to retry", async () => {
    const { backend } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    let attempts = 0;
    const listTargets = core.projectManager.listTargets.bind(core.projectManager);
    core.projectManager.listTargets = async (project) => {
      attempts += 1;
      if (attempts === 1) throw new Error("aws-targets.json is unreadable");
      return listTargets(project);
    };
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "✗ aws-targets.json is unreadable");
    expect(r.lastFrame()).toContain("[r] retry");
    expect(r.lastFrame()).toContain("[esc] back");

    await r.write("r");
    await waitForText(r.lastFrame, "✔ Deployed project 'orders' to target 'default'");
    // Loading retries once, then deploy itself re-reads through listTargets.
    expect(attempts).toBe(3);
    r.unmount();
  });

  test("esc leaves a target-loading failure for the project menu", async () => {
    const core = new TestCoreClient({ backends: { CDK: fakeBackend().backend } });
    await inProject(core);
    core.projectManager.listTargets = async () => {
      throw new Error("aws-targets.json is unreadable");
    };
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "✗ aws-targets.json is unreadable");
    await r.press("escape");
    await waitForText(r.lastFrame, "manage an AgentCore project");
    r.unmount();
  });

  test("several targets: asks which, and deploys to the chosen one", async () => {
    const { backend, deploys } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core, { staging: true });
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "choose a deployment target");
    const picker = flatFrame(r.lastFrame);
    expect(picker).toContain("default 111122223333 us-east-1");
    expect(picker).toContain("staging 444455556666 eu-west-1");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "✔ Deployed project 'orders' to target 'staging'");
    expect(flatFrame(r.lastFrame)).toContain("target staging");
    expect(deploys[0]!.input.target).toEqual(STAGING);
    r.unmount();
  });

  test("revisiting reads targets afresh before starting another deploy", async () => {
    const { backend, deploys } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    const projectRoot = await inProject(core);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      },
    });
    const r = renderScreen("/agentcore/project/deploy", { core, queryClient });

    await waitForText(r.lastFrame, "✔ Deployed project 'orders' to target 'default'");
    expect(deploys).toHaveLength(1);
    await r.press("return");
    await waitForText(r.lastFrame, "manage an AgentCore project");

    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "default", account: "111122223333", region: "us-east-1" }, STAGING]),
    );
    await r.write("deploy");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a deployment target");
    expect(deploys).toHaveLength(1);
    r.unmount();
  });

  test("revisiting resolves the project afresh before deciding whether to confirm teardown", async () => {
    const { backend, deploys } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    const projectRoot = await inProject(core);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      },
    });
    const r = renderScreen("/agentcore/project/deploy", { core, queryClient });

    await waitForText(r.lastFrame, "✔ Deployed project 'orders' to target 'default'");
    expect(deploys).toHaveLength(1);
    await r.press("return");
    await waitForText(r.lastFrame, "manage an AgentCore project");

    await writeFile(
      join(projectRoot, "agentcore", "agentcore.json"),
      JSON.stringify({ name: "orders", version: 1 }),
    );
    await r.write("deploy");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "declares no resources to deploy");
    expect(deploys).toHaveLength(1);
    r.unmount();
  });

  test("a fresh project with no aws-targets.json deploys, provisioning the default target as the CLI does", async () => {
    const { backend, deploys } = fakeBackend();
    const core = new TestCoreClient({
      backends: { CDK: backend },
      resolveAccount: async () => "887863153624",
    });
    await inProject(core, { targets: false });
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "✔ Deployed project 'orders' to target 'default'");
    const frame = flatFrame(r.lastFrame);
    // The manager's own provisioning step streams through like any other.
    expect(frame).toContain("✓ Created default deployment target: account 887863153624");
    expect(deploys[0]!.input.target).toMatchObject({ name: "default", account: "887863153624" });
    r.unmount();
  });

  test("an empty project asks the CLI's teardown question and confirms it on yes", async () => {
    const { backend, deploys } = fakeBackend({ result: { outputs: {}, tornDown: true } });
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core, { empty: true });
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForFlatText(r.lastFrame, "declares no resources to deploy");
    // Confirm lays its (y/N) inline, so the question wraps around it.
    expect(flatFrame(r.lastFrame)).toContain(
      "deployed to target 'default' (111122223333/us-east-1). Continue?",
    );
    await r.write("y");

    await waitForText(r.lastFrame, "✔ Removed project 'orders' from target 'default'");
    expect(deploys[0]!.confirmed).toBe(true);
    r.unmount();
  });

  test("the outcome follows the result, not the preflight heuristic", async () => {
    // The spec declares resources, so no teardown is asked — yet the backend
    // reports it tore the stack down (nothing synthesized). The title must say
    // what happened, as the command's own line does.
    const { backend } = fakeBackend({ result: { outputs: {}, tornDown: true } });
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "✔ Removed project 'orders' from target 'default'");
    expect(r.lastFrame()).not.toContain("Deployed project");
    r.unmount();
  });

  test("a failing deploy keeps the completed steps above the error", async () => {
    const { backend } = fakeBackend({ failure: new Error("stack rolled back") });
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "✗ stack rolled back");
    expect(r.lastFrame()).toContain("✕ Deploying stack");
    r.unmount();
  });
});
