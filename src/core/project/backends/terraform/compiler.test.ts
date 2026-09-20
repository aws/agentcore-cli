import { describe, expect, test } from "bun:test";
import { TerraformCompiler, literal } from "./compiler";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { Project } from "../../../../handlers/project/types";

const target = { name: "dev", account: "111122223333", region: "us-west-2" as const };
function project(spec: Record<string, unknown> = {}): Project {
  const parsed = ProjectSpecSchema.parse({
    name: "Demo",
    version: 1,
    managedBy: "TERRAFORM",
    ...spec,
  });
  return { name: parsed.name, rootPath: "/tmp/demo", spec: parsed };
}
const runtime = {
  name: "agent",
  build: "CodeZip",
  runtimeVersion: "PYTHON_3_12",
  entrypoint: "main.py",
  codeLocation: "app/agent",
};
const artifacts = { agent: { path: "/tmp/demo/agent.zip", sha256: "abc123" } };

describe("Terraform compiler", () => {
  test.each([
    [
      "memories",
      [{ name: "history", eventExpiryDuration: 30, strategies: [{ type: "SEMANTIC" }] }],
    ],
    ["harnesses", [{ name: "agent", path: "app/agent" }]],
    ["runtimes", [{ ...runtime, endpoints: { stable: { version: 1 } } }]],
    ["runtimes", [{ ...runtime, instrumentation: { enableOtel: true } }]],
    ["runtimes", [{ ...runtime, runtimeVersion: "NODE_22", entrypoint: "main.js" }]],
  ])("rejects unsupported %s before producing configuration", (field, value) => {
    expect(() =>
      new TerraformCompiler().compile(project({ [field]: value }), target, artifacts),
    ).toThrow("Terraform");
  });

  test("renders individually managed resources, physical names, and memory discovery references", () => {
    const compiler = new TerraformCompiler();
    const output = compiler.compile(
      project({
        memories: [{ name: "history", eventExpiryDuration: 30 }],
        runtimes: [{ ...runtime, envVars: [{ name: "EXAMPLE", value: "${not.an.expression}" }] }],
      }),
      target,
      artifacts,
    );
    const agent = output.resource[compiler.provider.runtimeType]!.agent!;
    expect(agent.agent_runtime_name).toBe("Demo_dev_agent");
    expect(agent.environment_variables).toEqual({
      EXAMPLE: "$${not.an.expression}",
      AGENTCORE_MEMORY_HISTORY_ID: `\${${compiler.provider.memoryType}.history.${compiler.provider.memoryId}}`,
    });
    expect(output.resource.aws_cloudformation_stack).toBeUndefined();
    expect(output.resource.aws_s3_bucket!.artifacts!.lifecycle).toEqual({ prevent_destroy: true });
    expect(JSON.stringify(output)).not.toContain("secretAccessKey");
  });

  test("changing a runtime description keeps Terraform addresses and artifact keys stable", () => {
    const compiler = new TerraformCompiler();
    const before = compiler.compile(project({ runtimes: [runtime] }), target, artifacts);
    const after = compiler.compile(
      project({ runtimes: [{ ...runtime, description: "new" }] }),
      target,
      artifacts,
    );
    expect(Object.keys(before.resource[compiler.provider.runtimeType]!)).toEqual(
      Object.keys(after.resource[compiler.provider.runtimeType]!),
    );
    expect(before.resource.aws_s3_object).toEqual(after.resource.aws_s3_object);
  });

  test("provided execution roles are not mutated", () => {
    const output = new TerraformCompiler().compile(
      project({
        runtimes: [{ ...runtime, executionRoleArn: "arn:aws:iam::111122223333:role/provided" }],
      }),
      target,
      artifacts,
    );
    expect(output.resource.aws_iam_role).toBeUndefined();
    expect(output.resource.aws_iam_role_policy).toBeUndefined();
  });

  test("refuses physical names exceeding service limits instead of silently changing them", () => {
    expect(() =>
      new TerraformCompiler().compile(
        project({
          memories: [{ name: "a".repeat(48), eventExpiryDuration: 30 }],
        }),
        target,
        {},
      ),
    ).toThrow("exceeds 48");
  });

  test.each([
    ['${file("secret")}', '$${file("secret")}'],
    ["%{ if true }", "%%{ if true }"],
    ["plain text", "plain text"],
  ])("keeps user text literal: %s", (value, expected) => {
    expect(literal(value)).toBe(expected);
  });
});
