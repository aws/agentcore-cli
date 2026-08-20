import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey, Router, ValueContext } from "../../../router";
import { testIO } from "../../../testing";
import { JsonRendererKey } from "../../../tui";
import { JsonKey } from "../../keys";
import type {
  AddResourceInput,
  CreateProjectInput,
  DeployProjectInput,
  DeployResult,
  Project,
  ProjectEvent,
  ProjectManager,
} from "../types";
import { createDeployProjectHandler } from ".";

const project: Project = {
  name: "orders",
  rootPath: "/workspace/orders",
  spec: ProjectSpecSchema.parse({ name: "orders", version: 1 }),
};

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

function harness(result: DeployResult, options: { events?: ProjectEvent[]; json?: boolean } = {}) {
  const io = testIO();
  const fake = fakeProjectManager(result, options.events);
  const handler = createDeployProjectHandler({ projectManager: fake.manager, io: io.io });
  const ctx = ValueContext.EmptyContext()
    .withValue(ProjectKey, project)
    .withValue(JsonKey, options.json ?? false)
    .withValue(JsonRendererKey, {
      renderJson: (data) => io.io.stdout.write(`${JSON.stringify(data, null, 2)}\n`),
      renderJsonLine: (data) => io.io.stdout.write(`${JSON.stringify(data)}\n`),
    });
  const router = new Router("project", "test");
  router.handler(handler);

  return {
    ...fake,
    io,
    run: (args: string[] = []) => router.route(["node", "project", "deploy", ...args], ctx),
  };
}

describe("project deploy handler", () => {
  test("defaults to the default target and keeps progress off stdout", async () => {
    const subject = harness(
      { outputs: { ZetaUrl: "https://zeta.example", AlphaArn: "arn:alpha" } },
      { events: [{ message: "Preparing deployment" }, { message: "Deploying stack" }] },
    );

    await subject.run();

    expect(subject.calls).toEqual([{ project, input: { target: "default" } }]);
    expect(subject.io.stderr()).toContain("Preparing deployment\nDeploying stack");
    expect(subject.io.stderr()).toContain("Deployed project 'orders' to target 'default'");
    expect(subject.io.stdout()).toBe("AlphaArn: arn:alpha\nZetaUrl: https://zeta.example");
  });

  test("passes an explicit target and renders the result as JSON", async () => {
    const result = { outputs: { ServiceUrl: "https://service.example" } };
    const subject = harness(result, { json: true });

    await subject.run(["--target", "staging"]);

    expect(subject.calls).toEqual([{ project, input: { target: "staging" } }]);
    expect(JSON.parse(subject.io.stdout())).toEqual(result);
  });
});
