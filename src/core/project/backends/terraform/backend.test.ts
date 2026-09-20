import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerraformBackend } from "../terraform";
import { TerraformRunner } from "./runner";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const target = { name: "dev", account: "111122223333", region: "us-west-2" as const };
async function fixture(): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "terraform-backend-test-"));
  roots.push(rootPath);
  return {
    name: "Demo",
    rootPath,
    spec: ProjectSpecSchema.parse({
      name: "Demo",
      version: 1,
      managedBy: "TERRAFORM",
      memories: [{ name: "history", eventExpiryDuration: 30 }],
    }),
  };
}
async function finish<T>(events: AsyncGenerator<ProjectEvent, T>): Promise<T> {
  while (true) {
    const event = await events.next();
    if (event.done) return event.value;
  }
}
function harness(project: Project, removals = false, failApply = false) {
  const commands: string[][] = [];
  const terraform = new TerraformRunner(async function* (command, { env }) {
    commands.push(command);
    expect(env?.AWS_REGION).toBe(target.region);
    expect(env?.AWS_ACCESS_KEY_ID).toBe("example-access");
    expect(env?.AWS_PROFILE).toBeUndefined();
    if (command[1] === "show") {
      yield {
        type: "stdout",
        line: JSON.stringify({
          resource_changes: removals
            ? [{ address: "memory.history", change: { actions: ["delete", "create"] } }]
            : [],
        }),
      };
    } else if (command[1] === "output") {
      yield {
        type: "stdout",
        line: JSON.stringify({
          agentcore: {
            value: {
              version: 1,
              project: project.name,
              target,
              resources: [
                {
                  resourceType: "memory",
                  name: "history",
                  id: "history-123",
                  arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/history-123",
                },
              ],
            },
          },
        }),
      };
    } else if (command[1] === "apply" && failApply) {
      throw new Error("apply failed after a partial deployment");
    }
  });
  return {
    commands,
    backend: new TerraformBackend({
      terraform,
      checkTool: async () => {},
      resolveIdentity: async () => ({
        account: target.account,
        credentials: async () => ({
          accessKeyId: "example-access",
          secretAccessKey: "example-secret",
        }),
      }),
    }),
  };
}

test("applies the exact saved plan and maps outputs without persisting credentials", async () => {
  const project = await fixture();
  const { commands, backend } = harness(project);
  const result = await finish(
    backend.deploy(project, { target, confirmTeardown: async () => true }),
  );
  const plan = commands.find((command) => command[1] === "plan")!;
  const apply = commands.find((command) => command[1] === "apply")!;
  expect(apply.at(-1)).toBe(plan.find((argument) => argument.startsWith("-out="))!.slice(5));
  expect(result.outputs["memory/history"]).toEndWith("memory/history-123");
  const directory = join(project.rootPath, "agentcore", "terraform", target.name);
  const config = await readFile(join(directory, "agentcore.generated.tf.json"), "utf8");
  expect(config).not.toContain("example-secret");
  expect(await readdir(directory)).not.toContain(".agentcore.lock");
  expect(await backend.resolveProjectResources(project, { target })).toEqual([
    { resourceType: "memory", name: "history", deploymentState: "deployed", id: "history-123" },
  ]);
});

test("a declined replacement never applies and leaves the generated configuration", async () => {
  const project = await fixture();
  const { commands, backend } = harness(project, true);
  await expect(
    finish(
      backend.deploy(project, {
        target,
        confirmTeardown: async (request) => {
          expect(request.resourceDescription).toBe("memory.history");
          return false;
        },
      }),
    ),
  ).rejects.toThrow("cancelled");
  expect(commands.some((command) => command[1] === "apply")).toBe(false);
  expect(await readdir(join(project.rootPath, "agentcore", "terraform", target.name))).toContain(
    "agentcore.generated.tf.json",
  );
});

test("a partial apply failure preserves the binding for retry and releases the local lock", async () => {
  const project = await fixture();
  const { backend } = harness(project, false, true);
  await expect(
    finish(backend.deploy(project, { target, confirmTeardown: async () => true })),
  ).rejects.toThrow("partial deployment");
  const files = await readdir(join(project.rootPath, "agentcore", "terraform", target.name));
  expect(files).toContain("deployment.json");
  expect(files).not.toContain(".agentcore.lock");
});

test("wrong-account credentials fail before starting Terraform", async () => {
  const project = await fixture();
  let ran = false;
  const backend = new TerraformBackend({
    checkTool: async () => {},
    terraform: new TerraformRunner(async function* () {
      ran = true;
      yield { type: "stdout", line: "{}" };
    }),
    resolveIdentity: async () => ({
      account: "444455556666",
      credentials: async () => ({
        accessKeyId: "example-access",
        secretAccessKey: "example-secret",
      }),
    }),
  });
  await expect(
    finish(backend.deploy(project, { target, confirmTeardown: async () => true })),
  ).rejects.toThrow("differs");
  expect(ran).toBe(false);
});
