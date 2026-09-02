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
import type { ProjectBackend } from "../../../core/project";
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

function testStatusCommand(deployed: ResolvedProjectResource[] = []) {
  const io = testIO();
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
      /No deployment targets are configured for project 'orders'/,
    );
    expect(subject.targets).toEqual([]);
  });

  test("--target selects another target, and an unknown one is rejected", async () => {
    const subject = testStatusCommand([]);
    await inProject(subject);

    await subject.run(["--target", "staging"]);

    expect(subject.targets).toEqual([STAGING_TARGET]);
    expect(subject.json()).toMatchObject({ target: "staging", region: "eu-west-1" });

    await expect(subject.run(["--target", "typo"])).rejects.toThrow(
      /has no deployment target named 'typo'/,
    );
  });
});
