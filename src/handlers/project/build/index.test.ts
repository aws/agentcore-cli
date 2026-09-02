import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import type { DeployResult, ProjectEvent } from "../types";
import type { ProjectBackend } from "../../../core/project";

type TestBuildOptions = {
  events?: ProjectEvent[];
  /** Thrown by the fake backend after its events, to exercise failure paths. */
  failure?: Error;
};

/** Stubs the backend so the real FsProjectManager and withProject stay in the path. */
function testBuildCommand(options: TestBuildOptions = {}) {
  const io = testIO();
  const backend: ProjectBackend = {
    async *build() {
      yield* options.events ?? [];
      if (options.failure) throw options.failure;
    },
    deploy(): AsyncGenerator<ProjectEvent, DeployResult> {
      throw new Error("deploy is not under test");
    },
    async resolveDeployedResources() {
      return [];
    },
  };
  const core = new TestCoreClient({ backends: { CDK: backend } });
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });

  return {
    io,
    run: (args: string[] = []) => root.route(["node", "agentcore", "project", "build", ...args]),
    create: (args: string[]) => root.route(["node", "agentcore", "project", ...args]),
  };
}

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project named 'orders' and cds into it. */
async function inProject(subject: ReturnType<typeof testBuildCommand>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-build-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  await subject.create(["create", "--name", "orders", "--skip-install", "--skip-git"]);
  process.chdir(join(process.cwd(), "orders"));
}

describe("project build handler", () => {
  test("writes step lines and the success line to stderr, nothing to stdout", async () => {
    const subject = testBuildCommand({
      events: [
        { type: "step", message: "Synthesizing CloudFormation templates" },
        { type: "output", line: "synth chatter" },
      ],
    });
    await inProject(subject);

    await subject.run();

    expect(subject.io.stderr()).toContain("Synthesizing CloudFormation templates");
    expect(subject.io.stderr()).toContain("Built project 'orders'");
    // Output lines belong to the debug log outside a TTY, not the plain stream.
    expect(subject.io.stderr()).not.toContain("synth chatter");
    expect(subject.io.stdout()).toBe("");
  });

  test("renders the success message as JSON with --json", async () => {
    const subject = testBuildCommand();
    await inProject(subject);

    await subject.run(["--json"]);

    expect(JSON.parse(subject.io.stdout())).toEqual({ message: "Built project 'orders'" });
  });

  test("renders a build failure as JSON without changing the thrown error", async () => {
    const failure = new Error("cdk synth exploded");
    const subject = testBuildCommand({ failure });
    await inProject(subject);

    await expect(subject.run(["--json"])).rejects.toThrow("cdk synth exploded");

    expect(JSON.parse(subject.io.stdout())).toEqual({ error: "cdk synth exploded" });
    expect(subject.io.stderr()).not.toContain("Built project");
  });

  test("keeps stdout empty on failure without --json", async () => {
    const subject = testBuildCommand({ failure: new Error("cdk synth exploded") });
    await inProject(subject);

    await expect(subject.run()).rejects.toThrow("cdk synth exploded");

    expect(subject.io.stdout()).toBe("");
  });
});
