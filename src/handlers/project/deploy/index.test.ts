import { describe, expect, test } from "bun:test";
import { createRootHandler } from "../../index";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import type {
  AddResourceInput,
  CreateProjectInput,
  DeployProjectInput,
  DeployResult,
  Project,
  ProjectEvent,
  ProjectManager,
} from "../types";

const project: Project = {
  name: "orders",
  rootPath: "/workspace/orders",
  spec: ProjectSpecSchema.parse({ name: "orders", version: 1 }),
};

/**
 * A ProjectManager whose deploy() succeeds, which the real one cannot do until
 * CDK deployment is implemented. resolve() always returns a project, so these
 * tests need no scaffolding on disk — withProject is satisfied by the manager.
 */
function fakeProjectManager(result: DeployResult, events: ProjectEvent[] = []) {
  const calls: { project: Project; input: DeployProjectInput }[] = [];
  const manager: ProjectManager = {
    async *create(_input: CreateProjectInput) {
      yield* [];
      return project;
    },
    async *build(_project: Project) {},
    async *deploy(deployedProject, input) {
      calls.push({ project: deployedProject, input });
      yield* events;
      return result;
    },
    async resolve() {
      return project;
    },
    async *addResource(_project: Project, _input: AddResourceInput) {
      yield* [];
      return project;
    },
  };
  return { calls, manager };
}

// Routes through createRootHandler rather than mounting the handler directly, so
// the global --json flag, the real JSON renderer and the withProject wrap are the
// ones the CLI actually installs instead of a context assembled by hand.
function harness(result: DeployResult, events: ProjectEvent[] = []) {
  const io = testIO();
  const fake = fakeProjectManager(result, events);
  const core = new TestCoreClient({ projectManager: fake.manager });
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });

  return {
    ...fake,
    io,
    run: (args: string[] = []) => root.route(["node", "agentcore", "project", "deploy", ...args]),
  };
}

describe("project deploy handler", () => {
  test("defaults to the default target and keeps progress off stdout", async () => {
    const subject = harness(
      { outputs: { ZetaUrl: "https://zeta.example", AlphaArn: "arn:alpha" } },
      [{ message: "Preparing deployment" }, { message: "Deploying stack" }],
    );

    await subject.run();

    expect(subject.calls).toEqual([{ project, input: { target: "default" } }]);
    expect(subject.io.stderr()).toContain("Preparing deployment\nDeploying stack");
    expect(subject.io.stderr()).toContain("Deployed project 'orders' to target 'default'");
    expect(subject.io.stdout()).toBe("AlphaArn: arn:alpha\nZetaUrl: https://zeta.example");
  });

  test("passes an explicit target and renders the result as JSON", async () => {
    const result = { outputs: { ServiceUrl: "https://service.example" } };
    const subject = harness(result);

    await subject.run(["--target", "staging", "--json"]);

    expect(subject.calls).toEqual([{ project, input: { target: "staging" } }]);
    expect(JSON.parse(subject.io.stdout())).toEqual(result);
  });
});
