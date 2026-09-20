import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { Project } from "../../../../handlers/project/types";
import { TerraformState, assertBackendOwnership, lockTarget, terraformDirectory } from "./state";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const target = { name: "dev", account: "111122223333", region: "us-west-2" as const };
async function fixture(): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "terraform-state-test-"));
  roots.push(rootPath);
  return {
    name: "Demo",
    rootPath,
    spec: ProjectSpecSchema.parse({ name: "Demo", version: 1, managedBy: "TERRAFORM" }),
  };
}

test.each([
  ["account", "444455556666"],
  ["region", "us-east-1"],
])("refuses rebinding a target's %s", async (field, value) => {
  const project = await fixture();
  const state = new TerraformState("test");
  await mkdir(terraformDirectory(project, target), { recursive: true });
  await state.bind(project, target);
  await expect(state.check(project, { ...target, [field]: value })).rejects.toThrow("migration");
});

test("refuses changing provider implementations on existing Terraform state", async () => {
  const project = await fixture();
  await mkdir(terraformDirectory(project, target), { recursive: true });
  await new TerraformState("native").bind(project, target);
  await expect(new TerraformState("awscc").check(project, target)).rejects.toThrow("migration");
});

test("refuses CDK and Terraform ownership changes in both directions", async () => {
  const project = await fixture();
  const cli = join(project.rootPath, "agentcore", ".cli");
  await mkdir(cli, { recursive: true });
  await writeFile(
    join(cli, "deployed-state.json"),
    JSON.stringify({ targets: { dev: { stackArn: "recorded-stack" } } }),
  );
  await expect(assertBackendOwnership(project, target)).rejects.toThrow("managed by CDK");
  await mkdir(terraformDirectory(project, target), { recursive: true });
  await writeFile(join(terraformDirectory(project, target), "deployment.json"), "{}");
  project.spec.managedBy = "CDK";
  await expect(assertBackendOwnership(project, target)).rejects.toThrow("bound to Terraform");
});

test("serializes target generation and releases the lock", async () => {
  const project = await fixture();
  const directory = terraformDirectory(project, target);
  const release = await lockTarget(directory);
  await expect(lockTarget(directory)).rejects.toThrow("Another deployment");
  await release();
  await (
    await lockTarget(directory)
  )();
});

test("rejects output ARNs from another account", async () => {
  const project = await fixture();
  const raw = {
    agentcore: {
      value: {
        version: 1,
        project: "Demo",
        target,
        resources: [
          {
            resourceType: "memory",
            name: "history",
            id: "history-123",
            arn: "arn:aws:bedrock-agentcore:us-west-2:444455556666:memory/history-123",
          },
        ],
      },
    },
  };
  expect(() => new TerraformState("test").parseOutputs(raw, project, target)).toThrow("Invalid");
});
