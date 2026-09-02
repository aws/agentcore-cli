import { afterEach, describe, expect, test } from "bun:test";
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
async function inProject(core: TestCoreClient, options: { empty?: boolean } = {}): Promise<string> {
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
  await writeFile(
    join(projectRoot, "agentcore", "aws-targets.json"),
    JSON.stringify([{ name: "default", account: "111122223333", region: "us-east-1" }]),
  );
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
  test("confirms, then renders the backend's steps as the CLI does, then the CLI's own success line", async () => {
    const { backend } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/build", { core });

    await waitForText(r.lastFrame, "Build project 'orders'?");
    expect(r.lastFrame()).toContain("agentcore → project → build");
    await r.write("y");

    // Both steps settle to ✓, as the inline TaskList leaves them on the
    // command line; the finished steps' output tails collapse.
    await waitForText(r.lastFrame, "✔ Built project 'orders'");
    const frame = r.lastFrame()!;
    expect(frame).toContain("✓ Synthesizing CloudFormation templates");
    expect(frame).toContain("✓ Deploying stack");
    expect(frame).not.toContain("cdk synth");
    r.unmount();
  });

  test("a failing step is marked ✕ with its output kept, above the error", async () => {
    const { backend } = fakeBackend({ failure: new Error("synth exploded") });
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/build", { core });

    await waitForText(r.lastFrame, "Build project 'orders'?");
    await r.write("y");

    await waitForText(r.lastFrame, "✗ synth exploded");
    const frame = r.lastFrame()!;
    expect(frame).toContain("✓ Synthesizing CloudFormation templates");
    expect(frame).toContain("✕ Deploying stack");
    expect(frame).toContain("CREATE_IN_PROGRESS | AWS::IAM::Role");
    r.unmount();
  });

  test("declining returns to the project menu", async () => {
    const core = new TestCoreClient({ backends: { CDK: fakeBackend().backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/build", { core });

    await waitForText(r.lastFrame, "Build project 'orders'?");
    await r.write("n");
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
    r.unmount();
  });
});

describe("project deploy screen", () => {
  test("shows the target, then the backend's steps, then the CLI's own success line and outputs", async () => {
    const { backend, deploys } = fakeBackend();
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "Deploy project 'orders' to target 'default'?");
    expect(flatFrame(r.lastFrame)).toContain("account 111122223333/us-east-1");
    await r.write("y");

    await waitForText(r.lastFrame, "✔ Project deployed");
    const frame = flatFrame(r.lastFrame);
    expect(frame).toContain("✓ Synthesizing CloudFormation templates");
    expect(frame).toContain("✓ Deploying stack");
    expect(frame).toContain("Deployed project 'orders' to target 'default'");
    expect(frame).toContain("RuntimeArn arn:runtime");

    // A project with resources never confirms a teardown, as on the command line.
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.confirmed).toBe(false);
    expect(deploys[0]!.input.target.name).toBe("default");
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

    await waitForText(r.lastFrame, "✔ Project removed");
    expect(flatFrame(r.lastFrame)).toContain("Removed project 'orders' from target 'default'");
    expect(deploys[0]!.confirmed).toBe(true);
    r.unmount();
  });

  test("a failing deploy keeps the completed steps above the error", async () => {
    const { backend } = fakeBackend({ failure: new Error("stack rolled back") });
    const core = new TestCoreClient({ backends: { CDK: backend } });
    await inProject(core);
    const r = renderScreen("/agentcore/project/deploy", { core });

    await waitForText(r.lastFrame, "Deploy project 'orders' to target 'default'?");
    await r.write("y");

    await waitForText(r.lastFrame, "✗ stack rolled back");
    expect(r.lastFrame()).toContain("✕ Deploying stack");
    r.unmount();
  });
});
