import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await mkdir(state.targetDirectory, { recursive: true });
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
    JSON.parse(await readFile(join(state.targetDirectory, ".agentcore-target.json"), "utf8")),
  ).toEqual(target);
});

test("adopts matching standalone Terraform state through its deployment_target output", async () => {
  const { state } = await fixture();
  const text = serialize(target);
  await writeFile(state.statePath, text);
  await state.bind(target);
  expect(await readFile(state.statePath, "utf8")).toBe(text);
  await expect(state.assertTarget({ ...target, region: "us-west-2" })).rejects.toThrow(
    "different target",
  );
});

test("refuses partial standalone state without an identity", async () => {
  const { state } = await fixture();
  await writeFile(state.statePath, serialize());
  await expect(state.bind(target)).rejects.toThrow("no deployment target identity");
});

test("refuses to start fresh when managed backup state exists but current state is missing", async () => {
  const { state } = await fixture();
  await writeFile(`${state.statePath}.backup`, serialize(target));
  await expect(state.bind(target)).rejects.toThrow("current Terraform state is missing");
});

test.each(["build", "default-111122223333-us-east-1", "."])(
  "refuses managed state in the earlier %s directory",
  async (legacyName) => {
    const { state } = await fixture();
    const legacy = join(state.directory, legacyName);
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
    await mkdir(other.targetDirectory, { recursive: true });
    await writeFile(other.statePath, serialize({ ...target, name }));
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
  await mkdir(state.dataDirectory, { recursive: true });
  await writeFile(join(state.dataDirectory, "terraform.tfstate"), JSON.stringify({ backend }));
  await expect(state.assertTarget(target)).rejects.toThrow("require local state");
});

test("accepts the selected target local state path", async () => {
  const { state } = await fixture();
  await mkdir(state.dataDirectory, { recursive: true });
  await writeFile(
    join(state.dataDirectory, "terraform.tfstate"),
    JSON.stringify({
      backend: { type: "local", config: { path: state.statePath } },
    }),
  );
  await state.assertTarget(target);
});

test("application teardown ignores customer resources outside the module", async () => {
  const { state } = await fixture();
  await writeFile(
    state.statePath,
    JSON.stringify({ resources: [{ mode: "managed", type: "aws_s3_bucket", name: "customer" }] }),
  );
  expect(await state.hasApplicationResources()).toBe(false);
});

test("named targets share source but isolate state, variables, plans, and provider data", async () => {
  const { project, state } = await fixture();
  const production = new TerraformState(project, "production");
  expect(state.directory).toBe(join(project.rootPath, "agentcore", "terraform"));
  expect(production.directory).toBe(state.directory);
  for (const key of [
    "targetDirectory",
    "statePath",
    "variablesPath",
    "planPath",
    "dataDirectory",
  ] as const) {
    expect(production[key]).not.toBe(state[key]);
  }
  await state.bind(target);
  await mkdir(production.targetDirectory, { recursive: true });
  await production.bind({ ...target, name: "production", region: "us-west-2" });
  await state.assertTarget(target);
  await production.assertTarget({ ...target, name: "production", region: "us-west-2" });
});

test("one source operation lock excludes every target", async () => {
  const { project, state } = await fixture();
  const production = new TerraformState(project, "production");
  const unlock = await state.lock();
  try {
    await expect(production.lock()).rejects.toThrow("Another operation owns");
  } finally {
    await unlock();
  }
  const unlockProduction = await production.lock();
  await unlockProduction();
});

test.each(["default", "production", "modules", "assets"])(
  "refuses an earlier editable root at %s even without state",
  async (name) => {
    const { state } = await fixture();
    const legacy = join(state.directory, name);
    await mkdir(legacy, { recursive: true });
    const customerSource = "# customer changes must survive migration\n";
    await writeFile(join(legacy, "main.tf"), customerSource);
    await writeFile(
      join(legacy, "artifacts.json"),
      JSON.stringify({ runtimes: {}, gatewayTargets: {} }),
    );
    await expect(state.assertTarget(target)).rejects.toThrow("migration");
    expect(await readFile(join(legacy, "main.tf"), "utf8")).toBe(customerSource);
  },
);

test("allows ordinary customer module directories alongside the shared root", async () => {
  const { state } = await fixture();
  const module = join(state.directory, "custom-module");
  await mkdir(module);
  await writeFile(join(module, "main.tf"), "# custom resource module\n");
  await state.assertTarget(target);
  expect(await readFile(join(module, "main.tf"), "utf8")).toBe("# custom resource module\n");
});

test.each([
  { type: "s3" },
  { type: "cloud" },
  { type: "local", config: { path: "custom.tfstate" } },
  { type: "local", config: { path: "../outside.tfstate" } },
  { type: "local", config: { path: ".targets/default/nested/terraform.tfstate" } },
  {
    type: "local",
    config: { path: ".targets/default/terraform.tfstate", workspace_dir: "../workspaces" },
  },
])("refuses unsupported backend metadata from plain Terraform init: %j", async (backend) => {
  const { state } = await fixture();
  const dataDirectory = join(state.directory, ".terraform");
  await mkdir(dataDirectory);
  await writeFile(join(dataDirectory, "terraform.tfstate"), JSON.stringify({ backend }));
  await expect(state.assertTarget(target)).rejects.toThrow("require local state");
});

test.each(["default", "production", "modules", "assets"])(
  "accepts canonical %s state metadata from plain Terraform init",
  async (name) => {
    const { state } = await fixture();
    const dataDirectory = join(state.directory, ".terraform");
    await mkdir(dataDirectory);
    await writeFile(
      join(dataDirectory, "terraform.tfstate"),
      JSON.stringify({
        backend: { type: "local", config: { path: `.targets/${name}/terraform.tfstate` } },
      }),
    );
    await state.assertTarget(target);
  },
);
