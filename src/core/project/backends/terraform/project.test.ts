import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("all targets use the same customer source and keep independent explicit inputs", async () => {
  const root = await directory();
  const writer = new TerraformProjectWriter();
  await writer.write(root, target, emptyAssets);
  await writeFile(join(root, "main.tf"), "# shared application edit\n");
  await writeFile(join(root, "custom.tf"), "# shared customer resource\n");
  const production = { ...target, name: "production", region: "us-west-2" } as const;
  await writer.write(root, production, emptyAssets);
  expect(await readFile(join(root, "main.tf"), "utf8")).toBe("# shared application edit\n");
  expect(await readFile(join(root, "custom.tf"), "utf8")).toBe("# shared customer resource\n");
  for (const selected of [target, production]) {
    const directory = join(root, ".targets", selected.name);
    expect(JSON.parse(await readFile(join(directory, "deployment.tfvars.json"), "utf8"))).toEqual({
      target_name: selected.name,
      account_id: selected.account,
      region: selected.region,
    });
    expect(existsSync(join(directory, "main.tf"))).toBe(false);
  }
  expect(existsSync(join(root, "deployment.auto.tfvars.json"))).toBe(false);
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
  expect(main).toContain('jsondecode(file("${path.module}/../agentcore.json"))');
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
    ".targets",
    ".targets/test",
    ".targets/test/deployment.tfvars.json",
    "artifacts.json",
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
    ".targets/test/deployment.tfplan": "saved plan",
    ".targets/test/terraform.tfstate": JSON.stringify({
      resources: [{ mode: "managed", type: "aws_s3_bucket", name: "customer" }],
    }),
  };
  for (const [name, text] of Object.entries(preserved)) await writeFile(join(root, name), text);
  await writer.write(root, target, emptyAssets);
  for (const [name, text] of Object.entries(preserved)) {
    expect(await readFile(join(root, name), "utf8")).toBe(text);
  }
});

test("local customer modules remain shared without copying source into targets", async () => {
  const root = await directory();
  const writer = new TerraformProjectWriter();
  await writer.scaffold(root);
  await mkdir(join(root, "modules", "custom"), { recursive: true });
  await writeFile(join(root, "modules", "custom", "main.tf"), "# custom module\n");
  await writer.write(root, target, emptyAssets);
  await writer.write(root, { ...target, name: "production" }, emptyAssets);
  expect(await readFile(join(root, "modules", "custom", "main.tf"), "utf8")).toBe(
    "# custom module\n",
  );
  expect(existsSync(join(root, ".targets", target.name, "modules"))).toBe(false);
  expect(existsSync(join(root, ".targets", "production", "modules"))).toBe(false);
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
