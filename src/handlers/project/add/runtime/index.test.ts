import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { InputValidationError, NotImplementedError } from "../../../../errors";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-runtime-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(args: string[]) {
  const io = testIO();
  const core = new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

// TODO: Replace NotImplementedError assertions with output assertions once
// FsProjectManager.addResource supports the "runtime" resource type.
describe("project add runtime", () => {
  const byo = ["--code-location", "app/my_agent"];
  const template = ["--template", "hello-world-python"];

  test.each<[string, string[]]>([
    ["minimal — name only (defaults to template)", ["--name", "my_agent"]],
    ["explicit template path", ["--name", "my_agent", ...template]],
    ["minimal — BYO path with build", ["--name", "my_agent", ...byo, "--build", "CodeZip"]],
    [
      "BYO container with dockerfile",
      ["--name", "my_agent", ...byo, "--build", "Container", "--dockerfile", "Dockerfile"],
    ],
    [
      "entrypoint + runtime-version for CodeZip",
      [
        "--name",
        "my_agent",
        ...byo,
        "--build",
        "CodeZip",
        "--entrypoint",
        "app.py:main",
        "--runtime-version",
        "PYTHON_3_13",
      ],
    ],
    ["description", ["--name", "my_agent", ...template, "--description", "A test agent"]],
    [
      "role-arn",
      ["--name", "my_agent", ...template, "--role-arn", "arn:aws:iam::123456789012:role/MyRole"],
    ],
    [
      "network — VPC",
      [
        "--name",
        "my_agent",
        ...template,
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
      ],
    ],
    ["network — PUBLIC", ["--name", "my_agent", ...template, "--network-mode", "PUBLIC"]],
    [
      "authorizer — customJWT",
      [
        "--name",
        "my_agent",
        ...template,
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["app"]}}',
      ],
    ],
    ["protocol — MCP", ["--name", "my_agent", ...template, "--protocol", "MCP"]],
    ["protocol — A2A", ["--name", "my_agent", ...template, "--protocol", "A2A"]],
    ["protocol — AGUI", ["--name", "my_agent", ...template, "--protocol", "AGUI"]],
    [
      "request-header-allowlist",
      [
        "--name",
        "my_agent",
        ...template,
        "--request-header-allowlist",
        "X-Custom-Header",
        "Authorization",
      ],
    ],
    [
      "lifecycle-configuration",
      [
        "--name",
        "my_agent",
        ...template,
        "--lifecycle-configuration",
        '{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}',
      ],
    ],
    [
      "environment-variables",
      [
        "--name",
        "my_agent",
        ...template,
        "--environment-variables",
        '{"LOG_LEVEL":"debug","APP_ENV":"staging"}',
      ],
    ],
    [
      "filesystem-configurations — sessionStorage",
      [
        "--name",
        "my_agent",
        ...template,
        "--filesystem-configurations",
        '[{"sessionStorage":{"mountPath":"/mnt/data"}}]',
      ],
    ],
    [
      "filesystem-configurations — efsAccessPoint",
      [
        "--name",
        "my_agent",
        ...template,
        "--filesystem-configurations",
        '[{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}}]',
      ],
    ],
    [
      "filesystem-configurations — s3FilesAccessPoint",
      [
        "--name",
        "my_agent",
        ...template,
        "--filesystem-configurations",
        '[{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1","mountPath":"/mnt/s3"}}]',
      ],
    ],
    ["tags", ["--name", "my_agent", ...template, "--tags", '{"team":"ml","env":"prod"}']],
    [
      "dockerfile + build-context-path",
      [
        "--name",
        "my_agent",
        ...byo,
        "--build",
        "Container",
        "--dockerfile",
        "docker/Dockerfile.gpu",
        "--build-context-path",
        ".",
      ],
    ],
    [
      "custom-docker-build-args with dockerfile",
      [
        "--name",
        "my_agent",
        ...byo,
        "--build",
        "Container",
        "--dockerfile",
        "Dockerfile",
        "--custom-docker-build-args",
        '{"AGENT_NAME":"my_agent","VERSION":"1.0"}',
      ],
    ],
    [
      "custom-docker-build-args with build-context-path",
      [
        "--name",
        "my_agent",
        ...byo,
        "--build",
        "Container",
        "--build-context-path",
        ".",
        "--custom-docker-build-args",
        '{"AGENT_NAME":"my_agent"}',
      ],
    ],
    [
      "additional-policies",
      [
        "--name",
        "my_agent",
        ...template,
        "--additional-policies",
        "arn:aws:iam::123456789012:policy/MyPolicy",
      ],
    ],
    ["protocol shortcut", ["--name", "my_agent", ...template, "--protocol", "MCP"]],
    [
      "memory — create with strategies",
      [
        "--name",
        "my_agent",
        ...template,
        "--memory",
        '{"mode":"create","strategies":["SEMANTIC","EPISODIC"]}',
      ],
    ],
    [
      "memory — existing by ARN",
      [
        "--name",
        "my_agent",
        ...template,
        "--memory",
        '{"mode":"existing","arn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/MyMem"}',
      ],
    ],
    ["memory — disabled", ["--name", "my_agent", ...template, "--memory", '{"mode":"disabled"}']],
    ["model-provider — openai", ["--name", "my_agent", ...template, "--model-provider", "openai"]],
    [
      "build on template path (overlay)",
      ["--name", "my_agent", ...template, "--build", "Container"],
    ],
    [
      "network-config with vpcId",
      [
        "--name",
        "my_agent",
        ...byo,
        "--build",
        "Container",
        "--dockerfile",
        "Dockerfile",
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"],"vpcId":"vpc-0123456789abcdef0"}',
      ],
    ],
  ])("%s — accepts flags", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "runtime", ...flags])).rejects.toBeInstanceOf(NotImplementedError);
  });

  test.each<[string, string[]]>([
    ["missing --name", ["--template", "hello-world-python"]],
    [
      "--template and --code-location are mutually exclusive",
      ["--name", "my_agent", "--template", "hello-world-python", "--code-location", "app/agent"],
    ],
    [
      "--custom-docker-build-args requires --dockerfile or --build-context-path",
      [
        "--name",
        "my_agent",
        ...byo,
        "--build",
        "Container",
        "--custom-docker-build-args",
        '{"KEY":"value"}',
      ],
    ],
    [
      "invalid JSON in --network-config",
      ["--name", "my_agent", ...template, "--network-config", "{bad}"],
    ],
    [
      "--entrypoint is only available on BYO path",
      ["--name", "my_agent", ...template, "--entrypoint", "main.py"],
    ],
    [
      "--runtime-version is only available on BYO path",
      ["--name", "my_agent", ...template, "--runtime-version", "PYTHON_3_13"],
    ],
    [
      "--dockerfile is only available on BYO path",
      ["--name", "my_agent", ...template, "--dockerfile", "Dockerfile"],
    ],
    [
      "--build-context-path is only available on BYO path",
      ["--name", "my_agent", ...template, "--build-context-path", "."],
    ],
    [
      "--custom-docker-build-args is only available on BYO path",
      ["--name", "my_agent", ...template, "--custom-docker-build-args", '{"KEY":"val"}'],
    ],
    [
      "--memory is only available on template path",
      ["--name", "my_agent", ...byo, "--memory", '{"mode":"disabled"}'],
    ],
    [
      "--model-provider is only available on template path",
      ["--name", "my_agent", ...byo, "--model-provider", "openai"],
    ],
    [
      "--api-key is only available on template path",
      ["--name", "my_agent", ...byo, "--api-key", "-"],
    ],
    [
      "--api-key rejects an inline secret value",
      ["--name", "my_agent", ...template, "--api-key", "sk-inline"],
    ],
    [
      "invalid memory JSON schema",
      ["--name", "my_agent", ...template, "--memory", '{"mode":"invalid"}'],
    ],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "runtime", ...flags])).rejects.toBeInstanceOf(InputValidationError);
  });
});
