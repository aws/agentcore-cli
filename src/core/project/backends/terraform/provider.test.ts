import { expect, test } from "bun:test";
import { TerraformProvider } from "./provider";
import { TerraformCompiler } from "./compiler";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";

test("AWSCC supports the CloudFormation schema's three-day retention minimum", () => {
  const spec = ProjectSpecSchema.parse({
    name: "Demo",
    version: 1,
    managedBy: "TERRAFORM",
    memories: [{ name: "history", eventExpiryDuration: 3 }],
  });
  expect(() =>
    new TerraformCompiler().validate({ name: spec.name, rootPath: "/tmp/demo", spec }),
  ).not.toThrow();
});

test("AWSCC runtime uses a protocol string and object-shaped lifecycle attributes", () => {
  const provider = new TerraformProvider();
  expect(provider.runtime("HTTP", { idleRuntimeSessionTimeout: 60, maxLifetime: 300 })).toEqual({
    protocol_configuration: "HTTP",
    lifecycle_configuration: { idle_runtime_session_timeout: 60, max_lifetime: 300 },
  });
  expect(Object.keys(provider.requiredProviders)).toEqual(["aws", "awscc"]);
});
