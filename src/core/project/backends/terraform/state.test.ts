import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { TerraformState } from "./state";

const target = { name: "default", account: "111122223333", region: "us-east-1" } as const;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "terraform-state-"));
  roots.push(rootPath);
  const project: Project = {
    rootPath,
    name: "Example",
    spec: ProjectSpecSchema.parse({ name: "Example", version: 2, managedBy: "Terraform" }),
  };
  const state = new TerraformState(project);
  await mkdir(state.directory, { recursive: true });
  return { project, state };
}
const resource = { mode: "managed", module: "module.application" };
const serialize = (identity?: unknown) =>
  JSON.stringify({
    resources: [resource],
    outputs: identity ? { deployment_target: { value: identity } } : {},
  });

test.each([
  { ...target, account: "999900001111" },
  { ...target, region: "us-west-2" },
  { ...target, name: "production" },
] as const)("rejects replacing an established target identity: %j", async (replacement) => {
  const { state } = await fixture();
  await state.bind(target);
  await expect(state.assertTarget(replacement)).rejects.toThrow("different target");
  expect(
    JSON.parse(await readFile(join(state.directory, ".agentcore-target.json"), "utf8")),
  ).toEqual(target);
});

test("adopts matching standalone Terraform state through its deployment_target output", async () => {
  const { state } = await fixture();
  const text = serialize(target);
  await writeFile(join(state.directory, "terraform.tfstate"), text);
  await state.bind(target);
  expect(await readFile(join(state.directory, "terraform.tfstate"), "utf8")).toBe(text);
  await expect(state.assertTarget({ ...target, region: "us-west-2" })).rejects.toThrow(
    "different target",
  );
});

test("refuses partial standalone state without an identity", async () => {
  const { state } = await fixture();
  await writeFile(join(state.directory, "terraform.tfstate"), serialize());
  await expect(state.bind(target)).rejects.toThrow("no deployment target identity");
});

test("refuses to start fresh when managed backup state exists but current state is missing", async () => {
  const { state } = await fixture();
  await writeFile(join(state.directory, "terraform.tfstate.backup"), serialize(target));
  await expect(state.bind(target)).rejects.toThrow("current Terraform state is missing");
});

test.each(["build", "default-111122223333-us-east-1", "."])(
  "refuses managed state in the earlier %s directory",
  async (legacyName) => {
    const { state } = await fixture();
    const legacy = join(dirname(state.directory), legacyName);
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "terraform.tfstate"), serialize());
    await expect(state.assertTarget(target)).rejects.toThrow("earlier state directory");
  },
);

test.each(["build", "test-111122223333-us-east-1"])(
  "recognizes a new-layout named target called %s",
  async (name) => {
    const { project, state } = await fixture();
    const other = new TerraformState(project, name);
    await mkdir(other.directory, { recursive: true });
    await writeFile(join(other.directory, "terraform.tfstate"), serialize({ ...target, name }));
    await state.assertTarget(target);
  },
);

test.each([
  { type: "s3" },
  { type: "cloud" },
  { type: "local", config: { path: "../other.tfstate" } },
  { type: "local", config: { workspace_dir: "../other-workspace" } },
])("rejects unsupported initialized backend %j", async (backend) => {
  const { state } = await fixture();
  await mkdir(join(state.directory, ".terraform"));
  await writeFile(
    join(state.directory, ".terraform", "terraform.tfstate"),
    JSON.stringify({ backend }),
  );
  await expect(state.assertTarget(target)).rejects.toThrow("require local state");
});

test("accepts the default local state path", async () => {
  const { state } = await fixture();
  await mkdir(join(state.directory, ".terraform"));
  await writeFile(
    join(state.directory, ".terraform", "terraform.tfstate"),
    JSON.stringify({
      backend: { type: "local", config: { path: join(state.directory, "terraform.tfstate") } },
    }),
  );
  await state.assertTarget(target);
});

test("application teardown ignores customer resources outside the module", async () => {
  const { state } = await fixture();
  await writeFile(
    join(state.directory, "terraform.tfstate"),
    JSON.stringify({ resources: [{ mode: "managed", type: "aws_s3_bucket", name: "customer" }] }),
  );
  expect(await state.hasApplicationResources()).toBe(false);
});
