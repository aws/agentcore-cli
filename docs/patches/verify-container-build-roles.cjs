const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalRoot = path.resolve(process.argv[2]);
const patchedRoot = path.resolve(process.argv[3]);
const original = require(originalRoot);
const patched = require(patchedRoot);
const { App, Stack } = require(require.resolve("aws-cdk-lib", { paths: [patchedRoot] }));
const { Template } = require(require.resolve("aws-cdk-lib/assertions", { paths: [patchedRoot] }));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentcore-build-roles-"));
fs.mkdirSync(path.join(projectRoot, "agentcore"));
fs.mkdirSync(path.join(projectRoot, "app"));
fs.writeFileSync(path.join(projectRoot, "app", "main.py"), 'print("sample")\n');
fs.writeFileSync(
  path.join(projectRoot, "app", "Dockerfile"),
  "FROM public.ecr.aws/docker/library/python:3.12-slim\n",
);

const roles = {
  executionRoleArn: "arn:aws:iam::111122223333:role/Runtime",
  containerBuildRoleArn: "arn:aws:iam::111122223333:role/CodeBuild",
  containerBuildHandlerRoleArn: "arn:aws:iam::111122223333:role/Handler",
};
const runtime = (name, overrides = {}) => ({
  name,
  build: "Container",
  entrypoint: "main.py",
  codeLocation: "app",
  ...overrides,
});
function synth(library, runtimes, region = "us-east-1") {
  const props = library.transformAgentCoreJson(
    { name: "RoleTest", version: 2, runtimes },
    { projectRoot },
  );
  const app = new App();
  const stack = new Stack(app, "RoleTest", {
    env: { account: "111122223333", region },
  });
  new library.AgentCoreApplication(stack, "Application", props);
  return Template.fromStack(stack).toJSON();
}
const resources = (template, type) =>
  Object.values(template.Resources).filter((r) => r.Type === type);
function assertNoIam(template) {
  for (const type of ["AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"]) {
    assert.equal(resources(template, type).length, 0, type);
  }
}
try {
  assert.deepEqual(synth(patched, [runtime("worker")]), synth(original, [runtime("worker")]));
  const allImported = synth(patched, [runtime("worker", roles)]);
  assertNoIam(allImported);
  assert.equal(
    resources(allImported, "AWS::CodeBuild::Project")[0].Properties.ServiceRole,
    roles.containerBuildRoleArn,
  );
  assert.equal(
    resources(allImported, "AWS::Lambda::Function")[0].Properties.Role,
    roles.containerBuildHandlerRoleArn,
  );
  assert.equal(
    resources(allImported, "AWS::BedrockAgentCore::Runtime")[0].Properties.RoleArn,
    roles.executionRoleArn,
  );
  const shared = synth(patched, [runtime("first", roles), runtime("second", roles)]);
  assertNoIam(shared);
  assert.equal(resources(shared, "AWS::CodeBuild::Project").length, 1);
  const differentHandlers = synth(patched, [
    runtime("first", roles),
    runtime("second", {
      ...roles,
      containerBuildHandlerRoleArn: "arn:aws:iam::111122223333:role/OtherHandler",
    }),
  ]);
  assertNoIam(differentHandlers);
  assert.equal(resources(differentHandlers, "AWS::CodeBuild::Project").length, 1);
  assert.deepEqual(
    resources(differentHandlers, "AWS::Lambda::Function")
      .map((resource) => resource.Properties.Role)
      .sort(),
    [roles.containerBuildHandlerRoleArn, "arn:aws:iam::111122223333:role/OtherHandler"].sort(),
  );
  for (const runtimes of [
    [
      runtime("first", roles),
      runtime("second", {
        ...roles,
        containerBuildRoleArn: "arn:aws:iam::111122223333:role/Other",
      }),
    ],
    [runtime("first", roles), runtime("second")],
    [runtime("first"), runtime("second", roles)],
  ]) {
    assert.throws(() => synth(patched, runtimes), /Conflicting containerBuildRoleArn/);
  }
  const roleEntries = Object.entries(roles);
  for (let mask = 1; mask < 7; mask++) {
    const supplied = roleEntries.filter((_entry, index) => mask & (1 << index));
    const partial = Object.fromEntries(supplied);
    assert.equal(
      resources(synth(patched, [runtime("partial", partial)]), "AWS::IAM::Role").length,
      3 - supplied.length,
    );
  }
  // Check ARN preservation only. CDK may warn that a resource is unavailable in a region.
  for (const [partition, region] of [
    ["aws-cn", "cn-north-1"],
    ["aws-us-gov", "us-gov-west-1"],
  ]) {
    const partitionRoles = Object.fromEntries(
      roleEntries.map(([key, arn]) => [key, arn.replace("arn:aws:", `arn:${partition}:`)]),
    );
    const template = synth(patched, [runtime("partition", partitionRoles)], region);
    assertNoIam(template);
    assert.equal(
      resources(template, "AWS::CodeBuild::Project")[0].Properties.ServiceRole,
      partitionRoles.containerBuildRoleArn,
    );
    assert.equal(
      resources(template, "AWS::Lambda::Function")[0].Properties.Role,
      partitionRoles.containerBuildHandlerRoleArn,
    );
    assert.equal(
      resources(template, "AWS::BedrockAgentCore::Runtime")[0].Properties.RoleArn,
      partitionRoles.executionRoleArn,
    );
  }
  const vpc = {
    networkMode: "VPC",
    networkConfig: {
      vpcId: "vpc-0123456789abcdef0",
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    },
  };
  assert.deepEqual(
    synth(patched, [runtime("vpc_default", vpc)]),
    synth(original, [runtime("vpc_default", vpc)]),
  );
  assert.deepEqual(
    synth(patched, [runtime("first"), runtime("second")]),
    synth(original, [runtime("first"), runtime("second")]),
  );
  assertNoIam(synth(patched, [runtime("vpc", { ...roles, ...vpc })]));
  const separate = synth(patched, [
    runtime("public", roles),
    runtime("vpc", {
      ...roles,
      ...vpc,
      containerBuildRoleArn: "arn:aws:iam::111122223333:role/VpcBuild",
    }),
  ]);
  assertNoIam(separate);
  assert.equal(resources(separate, "AWS::CodeBuild::Project").length, 2);
  assert.throws(
    () =>
      patched.AgentEnvSpecSchema.parse({
        ...runtime("zip", roles),
        build: "CodeZip",
        runtimeVersion: "PYTHON_3_12",
      }),
    /only allowed for Container builds/,
  );
  console.log(
    "CDK synthesis and validation checks passed; default template unchanged; supplied roles produce no IAM resources.",
  );
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
