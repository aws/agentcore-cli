import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProjectBackend } from "../../core/project";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";
import type { Project } from "./types";

const OMITTED_ON_CREATE = ["datasets", "abTests", "unassignedTargets", "capacityProviders"];
const EXISTING_COLLECTIONS = {
  datasets: [
    {
      name: "examples",
      schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
      config: { managed: { location: "examples.jsonl" } },
    },
  ],
  abTests: [
    {
      name: "Experiment",
      gatewayRef: "{{gateway:tools}}",
      variants: [
        {
          name: "C",
          weight: 50,
          variantConfiguration: {
            configurationBundle: { bundleArn: "arn:bundle:control", bundleVersion: "1" },
          },
        },
        {
          name: "T1",
          weight: 50,
          variantConfiguration: {
            configurationBundle: { bundleArn: "arn:bundle:treatment", bundleVersion: "1" },
          },
        },
      ],
      evaluationConfig: { onlineEvaluationConfigArn: "arn:evaluation" },
    },
  ],
  unassignedTargets: [
    { name: "unattached", targetType: "mcpServer", endpoint: "https://unattached.example.com" },
  ],
  knowledgeBases: [
    { name: "catalog", dataSources: [{ type: "S3", uri: "s3://example-documents/catalog" }] },
  ],
  toolRuntimes: [
    {
      name: "lookup",
      toolDefinition: {
        name: "lookup",
        description: "Look up a product",
        inputSchema: { type: "object" },
      },
      compute: {
        host: "AgentCoreRuntime",
        implementation: { language: "Python", path: "tools", handler: "handler.main" },
      },
    },
  ],
  agentCoreGateways: [
    {
      name: "tools",
      targets: [
        {
          name: "knowledge",
          targetType: "connector",
          connectorId: "bedrock-knowledge-bases",
          configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: "catalog" } }],
        },
      ],
    },
  ],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

function subject() {
  const builds: Project[] = [];
  const deployments: Project[] = [];
  const backend: ProjectBackend = {
    async *build(project) {
      builds.push(project);
      yield { type: "step", message: "Building project" };
    },
    async *deploy(project) {
      deployments.push(project);
      yield { type: "step", message: "Deploying project" };
      return { outputs: {} };
    },
    async resolveDeployedResources() {
      return [];
    },
    async resolveProjectResources() {
      return [];
    },
  };
  const core = new TestCoreClient({ backends: { CDK: backend } });
  const root = createRootHandler(core, {
    io: testIO().io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return {
    core,
    builds,
    deployments,
    run: (args: string[]) => root.route(["node", "agentcore", "project", ...args]),
  };
}

async function createProject(flags: string[] = []) {
  const project = await initProject({ name: "Example", flags });
  cleanups.push(project.cleanup);
  return Bun.file(join(project.projectRoot, "agentcore", "agentcore.json"));
}

describe("new project configuration", () => {
  test.each([
    { name: "harness", flags: [] },
    { name: "empty", flags: ["--template", "empty"] },
    { name: "runtime", flags: ["--template", "agent-python-minimal"] },
  ])("creates a $name project without unused collection keys", async ({ flags }) => {
    const file = await createProject([...flags]);
    const contents = await file.text();
    const spec = JSON.parse(contents);
    for (const field of OMITTED_ON_CREATE) expect(spec).not.toHaveProperty(field);

    const project = await subject().core.projectManager.resolve({ filePath: file.name! });
    expect(project).toBeDefined();
    expect(project!.spec.knowledgeBases).toEqual([]);
    // Reading still applies baseline schema defaults in memory without
    // writing them back into the newly generated configuration.
    expect(project!.spec.abTests).toEqual([]);
    expect(await file.text()).toBe(contents);
  });

  test("preserves populated existing definitions through reads, edits, and backend handoff", async () => {
    const file = await createProject(["--template", "empty"]);
    const contents = JSON.stringify({ ...(await file.json()), ...EXISTING_COLLECTIONS });
    await Bun.write(file, contents);
    const instance = subject();
    const original = await instance.core.projectManager.resolve({ filePath: file.name! });
    expect(original).toBeDefined();
    expect(await file.text()).toBe(contents);

    await instance.run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "search",
      "--endpoint",
      "https://search.example.com",
    ]);
    expect((await file.json()).agentCoreGateways[0].targets).toHaveLength(2);
    await instance.run(["remove", "gateway-target", "--gateway", "tools", "--name", "search"]);
    const updated = await file.json();
    expect(updated).toEqual(original!.spec);
    for (const field of Object.keys(EXISTING_COLLECTIONS)) {
      expect(updated[field]).toHaveLength(1);
    }

    await Bun.write(
      join("agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "default", account: "111122223333", region: "us-east-1" }]),
    );
    await instance.run(["build"]);
    await instance.run(["deploy"]);
    expect(instance.builds).toHaveLength(1);
    expect(instance.deployments).toHaveLength(1);
    for (const project of [...instance.builds, ...instance.deployments]) {
      expect(project.spec).toEqual(updated);
    }
  });

  test.each(["datasets", "abTests", "unassignedTargets"])(
    "preserves an existing empty %s collection during an update",
    async (field) => {
      const file = await createProject(["--template", "empty"]);
      await Bun.write(file, JSON.stringify({ ...(await file.json()), [field]: [] }));
      await subject().run(["add", "gateway", "--name", "tools"]);
      expect((await file.json())[field]).toEqual([]);
    },
  );
});
