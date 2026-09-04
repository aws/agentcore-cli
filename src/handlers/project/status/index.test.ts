import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
} from "../../../testing";
import type { ProjectBackend } from "../../../core/project";
import { ProjectStateError } from "../../../errors";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { ResolvedProjectResource } from "../types";

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
const ARN = `arn:aws:bedrock-agentcore:${DEFAULT_TARGET.region}:${DEFAULT_TARGET.account}`;

function fakeBackend(deployed: ResolvedProjectResource[]) {
  const targets: AwsDeploymentTarget[] = [];
  const backend: ProjectBackend = {
    async *build() {},
    async *deploy() {
      yield { type: "step", message: "unused by these tests" };
      return { outputs: {} };
    },
    async resolveDeployedResources() {
      throw new Error("project status resolves project resources, not deployed resources");
    },
    async resolveProjectResources(_project, input) {
      targets.push(input.target);
      return deployed;
    },
  };
  return { targets, backend };
}

function testStatusCommand(deployed: ResolvedProjectResource[] = [], io = testIO()) {
  const fake = fakeBackend(deployed);
  const root = createRootHandler(new TestCoreClient({ backends: { CDK: fake.backend } }), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });

  return {
    ...fake,
    io,
    json: () => JSON.parse(io.stdout()),
    run: (args: string[] = []) => root.route(["node", "agentcore", "project", "status", ...args]),
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

// The report is refused when the ambient region is not the target's, so pin
// the ambient region to the default target's rather than leave it to the
// developer's shell (see withRegion for the fallback chain).
const SAVED_AWS_REGION = process.env.AWS_REGION;
beforeEach(() => {
  process.env.AWS_REGION = DEFAULT_TARGET.region;
});
afterEach(() => {
  if (SAVED_AWS_REGION === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = SAVED_AWS_REGION;
});

async function inProject(
  subject: ReturnType<typeof testStatusCommand>,
  spec: Record<string, unknown> = {},
  targets: AwsDeploymentTarget[] = TARGETS,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-status-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  await subject.create(["create", "--name", "orders", "--skip-install", "--skip-git"]);
  const projectRoot = join(process.cwd(), "orders");
  await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), JSON.stringify(targets));
  const specPath = join(projectRoot, "agentcore", "agentcore.json");
  const current = JSON.parse(await Bun.file(specPath).text());
  await writeFile(specPath, JSON.stringify({ ...current, ...spec }));
  process.chdir(projectRoot);
}

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
  children?: ResolvedProjectResource[],
): ResolvedProjectResource => ({
  resourceType,
  name,
  ...(children ? { children } : {}),
  deploymentState: "local-only",
});

const HARNESS_ROW = localOnly("harness", "orders");

const memory = (name: string) => ({ name, eventExpiryDuration: 30 });
const policy = (name: string) => ({ name, statement: "permit(principal, action, resource);" });
describe("project status handler", () => {
  test("reports deployed resources by ARN, nesting children under their owner", async () => {
    const subject = testStatusCommand([
      HARNESS_ROW,
      deployed("memory", "shortTerm", `${ARN}:memory/shortTerm-1`),
      deployed("policy-engine", "guards", `${ARN}:policy-engine/guards-1`, [
        deployed("policy", "noPii", `${ARN}:policy/noPii-1`),
      ]),
      localOnly("policy-engine", "empty"),
    ]);
    await inProject(subject, {
      memories: [memory("shortTerm")],
      policyEngines: [
        { name: "guards", policies: [policy("noPii")] },
        { name: "empty", policies: [] },
      ],
    });

    await subject.run();

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: "us-east-1",
      resources: [
        HARNESS_ROW,
        {
          resourceType: "memory",
          name: "shortTerm",
          deploymentState: "deployed",
          id: `${ARN}:memory/shortTerm-1`,
        },
        {
          resourceType: "policy-engine",
          name: "guards",
          deploymentState: "deployed",
          id: `${ARN}:policy-engine/guards-1`,
          children: [
            {
              resourceType: "policy",
              name: "noPii",
              deploymentState: "deployed",
              id: `${ARN}:policy/noPii-1`,
            },
          ],
        },
        { resourceType: "policy-engine", name: "empty", deploymentState: "local-only" },
      ],
    });
  });

  test("omits identifier for resources the stack does not hold", async () => {
    const subject = testStatusCommand([
      HARNESS_ROW,
      deployed("memory", "shortTerm", `${ARN}:memory/shortTerm-1`),
      localOnly("memory", "longTerm"),
    ]);
    await inProject(subject, { memories: [memory("shortTerm"), memory("longTerm")] });

    await subject.run();

    expect(subject.json().resources).toEqual([
      HARNESS_ROW,
      {
        resourceType: "memory",
        name: "shortTerm",
        deploymentState: "deployed",
        id: `${ARN}:memory/shortTerm-1`,
      },
      { resourceType: "memory", name: "longTerm", deploymentState: "local-only" },
    ]);
  });

  test("reports every resource local-only when nothing is deployed", async () => {
    const subject = testStatusCommand([HARNESS_ROW, localOnly("memory", "shortTerm")]);
    await inProject(subject, { memories: [memory("shortTerm")] });

    await subject.run();

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: "us-east-1",
      resources: [
        HARNESS_ROW,
        { resourceType: "memory", name: "shortTerm", deploymentState: "local-only" },
      ],
    });
  });

  test("rejects a project that declares no targets, without reaching the backend", async () => {
    const subject = testStatusCommand([localOnly("memory", "shortTerm")]);
    await inProject(subject, { memories: [memory("shortTerm")] }, []);

    await expect(subject.run()).rejects.toThrow(
      /No deployment targets are configured for project 'orders'\. Please deploy your project using 'agentcore project deploy'\./,
    );
    expect(subject.targets).toEqual([]);
  });

  test("--target selects another target, and an unknown one is rejected", async () => {
    const subject = testStatusCommand([]);
    await inProject(subject);

    await subject.run(["--region", STAGING_TARGET.region, "--target", "staging"]);

    expect(subject.targets).toEqual([STAGING_TARGET]);
    expect(subject.json()).toMatchObject({ target: "staging", region: "eu-west-1" });

    await expect(subject.run(["--target", "typo"])).rejects.toThrow(
      /has no deployment target named 'typo'/,
    );
  });

  test("refuses a target deployed outside the ambient region", async () => {
    const subject = testStatusCommand([HARNESS_ROW]);
    await inProject(subject);

    // The ambient region is the default target's (pinned above); staging's is not.
    const outcome = subject.run(["--target", "staging"]);
    await expect(outcome).rejects.toBeInstanceOf(ProjectStateError);
    await expect(outcome).rejects.toThrow("This project is deployed to eu-west-1, not us-east-1");
    // An explicit --region takes part in the same comparison.
    await expect(subject.run(["--region", "us-west-2"])).rejects.toThrow(
      "This project is deployed to us-east-1, not us-west-2",
    );
    expect(subject.io.stdout()).toBe("");
  });
});

describe("project status dispatch", () => {
  // The bare-invocation tests above run without a TTY and assert the exact
  // JSON envelope, which pins the non-TTY headless path; these cover how a TTY
  // changes (and does not change) the dispatch.
  test("bare status in a TTY session opens the TUI instead of printing JSON", async () => {
    const tty = ttyTestIO();
    const subject = testStatusCommand([HARNESS_ROW], tty.streams);
    await inProject(subject);

    // outcome never rejects, so a mid-pump failure cannot trip bun's
    // unhandled-rejection detection before the final assertion.
    const outcome = subject.run().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The screen never finishes on its own; Ctrl+C (re-sent until the app
    // reacts) closes it and resolves the route cleanly.
    await waitFor(
      () => {
        if (!settled) tty.stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(subject.io.stdout()).not.toContain('"projectName"');
  }, 10000);

  test("an explicitly passed --target stays headless even in a TTY", async () => {
    const subject = testStatusCommand([HARNESS_ROW], ttyTestIO().streams);
    await inProject(subject);

    await subject.run(["--target", "default"]);

    expect(subject.json()).toMatchObject({ projectName: "orders", target: "default" });
  });

  test("--json stays headless even in a TTY", async () => {
    const subject = testStatusCommand([HARNESS_ROW], ttyTestIO().streams);
    await inProject(subject);

    await subject.run(["--json"]);

    expect(subject.json()).toEqual({
      projectName: "orders",
      target: "default",
      region: "us-east-1",
      resources: [HARNESS_ROW],
    });
  });
});
