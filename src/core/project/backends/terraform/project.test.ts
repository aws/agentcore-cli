import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerraformProjectWriter } from "./project";

const target = { name: "test", account: "111122223333", region: "us-east-1" } as const;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "terraform-project-"));
  directories.push(path);
  return path;
}
const emptyAssets = { runtimes: {}, gatewayTargets: {} };
const modulePath = (root: string, name = "main.tf") =>
  join(root, "modules", "agentcore-application", name);

test("scaffolds immediately with a required account and no placeholder deployment inputs", async () => {
  const root = await directory();
  await new TerraformProjectWriter().scaffold(root, "eu-west-1");
  expect(existsSync(join(root, "main.tf"))).toBe(true);
  expect(existsSync(join(root, "deployment.auto.tfvars.json"))).toBe(false);
  const variables = await readFile(join(root, "variables.tf"), "utf8");
  expect(variables).toContain('default     = "default"');
  expect(variables).toContain('default     = "eu-west-1"');
  expect(variables).not.toContain("000000000000");
  expect(variables.split('variable "account_id"')[1]!.split('variable "region"')[0]).not.toContain(
    "default",
  );
});

test("a named target inherits customer Terraform source without copying state or target inputs", async () => {
  const parent = await directory();
  const original = join(parent, "default");
  const named = join(parent, "production");
  const writer = new TerraformProjectWriter();
  await writer.scaffold(original);
  await writeFile(join(original, "custom.tf"), "# custom resource\n");
  await writeFile(join(original, "custom.tf.json"), '{"resource":{}}\n');
  await writeFile(join(original, "terraform.tfstate"), '{"resources":[]}\n');
  await writeFile(join(original, "deployment.auto.tfvars.json"), '{"account_id":"111122223333"}\n');
  await writer.inheritRoot(named, original);
  await writer.write(named, { ...target, name: "production" }, emptyAssets);
  expect(await readFile(join(named, "custom.tf"), "utf8")).toBe("# custom resource\n");
  expect(await readFile(join(named, "custom.tf.json"), "utf8")).toBe('{"resource":{}}\n');
  expect(existsSync(join(named, "terraform.tfstate"))).toBe(false);
  expect(
    JSON.parse(await readFile(join(named, "deployment.auto.tfvars.json"), "utf8")).target_name,
  ).toBe("production");
});

test("scaffolds native HCL with a direct project file reference and portable artifact manifest", async () => {
  const root = await directory();
  await new TerraformProjectWriter().write(root, target, {
    runtimes: { Agent: { path: join(root, "assets", "agent.zip"), hash: "a".repeat(64) } },
    gatewayTargets: {},
  });
  const main = await readFile(join(root, "main.tf"), "utf8");
  expect(main).toContain(
    "git::https://github.com/jariy17/agentcore-l3-cdk-constructs.git//terraform/modules/agentcore-application?ref=",
  );
  expect(existsSync(join(root, "modules"))).toBe(false);
  expect(existsSync(join(root, ".terraform"))).toBe(false);
  expect(main).toContain('jsondecode(file("${path.module}/../../agentcore.json"))');
  expect(main).toContain('jsondecode(file("${path.module}/artifacts.json"))');
  expect(existsSync(join(root, "main.tf.json"))).toBe(false);
  expect(JSON.parse(await readFile(join(root, "artifacts.json"), "utf8")).runtimes.Agent.path).toBe(
    "assets/agent.zip",
  );
  expect(await readFile(join(root, "providers.tf"), "utf8")).toContain(
    "allowed_account_ids = [var.account_id]",
  );
  expect(await readFile(join(root, "outputs.tf"), "utf8")).toContain(
    "module.application.project_resources",
  );
  expect((await readdir(root, { recursive: true })).sort()).toEqual([
    "artifacts.json",
    "deployment.auto.tfvars.json",
    "main.tf",
    "outputs.tf",
    "providers.tf",
    "variables.tf",
  ]);
});

test("the module source is pinned to an immutable commit", async () => {
  const root = await directory();
  await new TerraformProjectWriter().scaffold(root);
  expect(await readFile(join(root, "main.tf"), "utf8")).toMatch(/\?ref=[a-f0-9]{40}"/);
});

test("preserves the customer's module source and inline spec", async () => {
  const root = await directory();
  const writer = new TerraformProjectWriter();
  await writer.write(root, target, emptyAssets);
  const custom =
    'module "application" { source = "./modules/custom" spec = { name = "Custom" } }\n';
  await writeFile(join(root, "main.tf"), custom);
  await writer.write(root, target, emptyAssets);
  expect(await readFile(join(root, "main.tf"), "utf8")).toBe(custom);
});

test("preserves customer root configuration and Terraform state, plans, and provider lock", async () => {
  const root = await directory();
  const writer = new TerraformProjectWriter();
  await writer.write(root, target, emptyAssets);
  const preserved: Record<string, string> = {
    "main.tf": "# custom main\n",
    "providers.tf": "# custom providers\n",
    "variables.tf": "# custom variables\n",
    "outputs.tf": "# custom outputs\n",
    "custom.tf": "# custom extra resources\n",
    ".terraform.lock.hcl": "# selected provider hashes\n",
    "deployment.tfplan": "saved plan",
    "terraform.tfstate": JSON.stringify({
      resources: [{ mode: "managed", type: "aws_s3_bucket", name: "customer" }],
    }),
  };
  for (const [name, text] of Object.entries(preserved)) await writeFile(join(root, name), text);
  await writer.write(root, target, emptyAssets);
  for (const [name, text] of Object.entries(preserved)) {
    expect(await readFile(join(root, name), "utf8")).toBe(text);
  }
});

test("inherits local customer modules without copying Terraform working files", async () => {
  const parent = await directory();
  const original = join(parent, "default");
  const named = join(parent, "production");
  const writer = new TerraformProjectWriter();
  await writer.scaffold(original);
  await mkdir(modulePath(original, ".terraform"), { recursive: true });
  await writeFile(modulePath(original), "# customer module\n");
  await writeFile(modulePath(original, ".terraform/provider"), "binary");
  await writeFile(modulePath(original, "terraform.tfstate"), "{}");
  await writer.inheritRoot(named, original);
  expect(await readdir(modulePath(named, ""))).toEqual(["main.tf"]);
  expect(await readFile(modulePath(named), "utf8")).toBe("# customer module\n");
});

test("refuses to follow local module symlinks during target inheritance", async () => {
  const parent = await directory();
  const outside = await directory();
  const original = join(parent, "default");
  const writer = new TerraformProjectWriter();
  await writer.scaffold(original);
  await symlink(outside, join(original, "modules"));
  await expect(writer.inheritRoot(join(parent, "production"), original)).rejects.toThrow(
    "symlinked",
  );
});

test.each(["main.tf.json", "terraform.tfstate", "terraform.tfstate.backup"])(
  "refuses the earlier flat PoC %s",
  async (filename) => {
    const root = await directory();
    const contents =
      filename === "main.tf.json"
        ? "{}"
        : JSON.stringify({
            resources: [{ mode: "managed", type: "awscc_bedrockagentcore_memory", name: "old" }],
          });
    await writeFile(join(root, filename), contents);
    await expect(new TerraformProjectWriter().write(root, target, emptyAssets)).rejects.toThrow(
      "migration",
    );
    expect(await readFile(join(root, filename), "utf8")).toBe(contents);
    expect(existsSync(join(root, "main.tf"))).toBe(false);
  },
);

test("an empty state permits initializing a module root", async () => {
  const root = await directory();
  await writeFile(join(root, "terraform.tfstate"), JSON.stringify({ resources: [] }));
  await new TerraformProjectWriter().write(root, target, emptyAssets);
  expect(existsSync(join(root, "main.tf"))).toBe(true);
});

test("refuses an existing state from a differently named module", async () => {
  const root = await directory();
  await writeFile(
    join(root, "terraform.tfstate"),
    JSON.stringify({ resources: [{ mode: "managed", module: "module.application_custom" }] }),
  );
  await expect(new TerraformProjectWriter().write(root, target, emptyAssets)).rejects.toThrow(
    "migration",
  );
});

test("rejects assets outside the root rather than writing a nonportable manifest", async () => {
  const root = await directory();
  await expect(
    new TerraformProjectWriter().write(root, target, {
      runtimes: { Agent: { path: join(root, "..", "outside.zip"), hash: "a".repeat(64) } },
      gatewayTargets: {},
    }),
  ).rejects.toThrow("Invalid Terraform artifact path");
  expect(existsSync(join(root, "main.tf"))).toBe(false);
});
