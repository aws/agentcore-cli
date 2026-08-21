import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import type { DeployBackendInput, ProjectBackend } from "../../../core/project";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { DeployResult, Project, ProjectEvent } from "../types";

const DEFAULT_TARGET: AwsDeploymentTarget = {
  name: "default",
  account: "111122223333",
  region: "us-east-1",
};
const STAGING_TARGET: AwsDeploymentTarget = {
  name: "staging",
  account: "444455556666",
  region: "eu-west-1",
};
const TARGETS = [DEFAULT_TARGET, STAGING_TARGET];

/**
 * A ProjectBackend that deploys successfully, which CdkBackend cannot do until
 * CDK deployment is implemented. Stubbing the backend rather than the whole
 * manager keeps the real FsProjectManager in the path, so target resolution and
 * withProject run for real.
 */
function fakeBackend(result: DeployResult, events: ProjectEvent[] = []) {
  const calls: { project: Project; input: DeployBackendInput }[] = [];
  const backend: ProjectBackend = {
    async *build() {},
    async *deploy(project, input) {
      calls.push({ project, input });
      yield* events;
      return result;
    },
  };
  return { calls, backend };
}

function harness(result: DeployResult, events: ProjectEvent[] = []) {
  const io = testIO();
  const fake = fakeBackend(result, events);
  const core = new TestCoreClient({ backends: { CDK: fake.backend } });
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });

  return {
    ...fake,
    io,
    run: (args: string[] = []) => root.route(["node", "agentcore", "project", "deploy", ...args]),
    create: (args: string[]) => root.route(["node", "agentcore", "project", ...args]),
  };
}

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-deploy-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project with deployment targets and cds into it. */
async function inProjectWithTargets(
  subject: ReturnType<typeof harness>,
  targets: unknown = TARGETS,
): Promise<string> {
  const directory = await inTempDirectory();
  await subject.create(["create", "--name", "orders", "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, "orders");
  await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), JSON.stringify(targets));
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project deploy handler", () => {
  test("defaults to the default target and keeps progress off stdout", async () => {
    const subject = harness(
      { outputs: { ZetaUrl: "https://zeta.example", AlphaArn: "arn:alpha" } },
      [{ message: "Preparing deployment" }, { message: "Deploying stack" }],
    );
    await inProjectWithTargets(subject);

    await subject.run();

    expect(subject.calls.map(({ input }) => input)).toEqual([{ target: DEFAULT_TARGET }]);
    expect(subject.io.stderr()).toContain("Preparing deployment\nDeploying stack");
    expect(subject.io.stderr()).toContain("Deployed project 'orders' to target 'default'");
    expect(subject.io.stdout()).toBe("AlphaArn: arn:alpha\nZetaUrl: https://zeta.example");
  });

  test("passes an explicit target and renders the result as JSON", async () => {
    const result = { outputs: { ServiceUrl: "https://service.example" } };
    const subject = harness(result);
    await inProjectWithTargets(subject);

    await subject.run(["--target", "staging", "--json"]);

    expect(subject.calls.map(({ input }) => input)).toEqual([{ target: STAGING_TARGET }]);
    expect(JSON.parse(subject.io.stdout())).toEqual(result);
  });

  test("rejects an unknown target without invoking the backend", async () => {
    const subject = harness({ outputs: {} });
    await inProjectWithTargets(subject);

    await expect(subject.run(["--target", "nope"])).rejects.toThrow(
      /no deployment target named 'nope'/,
    );
    expect(subject.calls).toEqual([]);
  });

  test("requires deployment targets to be configured", async () => {
    const subject = harness({ outputs: {} });
    await inProjectWithTargets(subject, []);

    await expect(subject.run()).rejects.toThrow(/No deployment targets are configured/);
    expect(subject.calls).toEqual([]);
  });
});
