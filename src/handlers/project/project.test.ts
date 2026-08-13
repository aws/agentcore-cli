import { afterEach, test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { InputValidationError } from "../../errors";
import type { CdkEvent, CdkOperation } from "../../io";

// The synth command build and deploy both issue. --output pins the assembly to the
// directory deploy reads, so cdk.json's own `output` cannot send the two apart.
function SYNTH(cdkDir: string): string[] {
  return ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", join(cdkDir, "cdk.out")];
}

async function run(
  args: string[],
  onCdkOperation?: (operation: CdkOperation, emit: (event: CdkEvent) => void) => void,
) {
  const io = testIO();
  const core = new TestCoreClient({ onCdkOperation });
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

describe.each(["remove", "dev", "status"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
});

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project and cds into it so withProject resolves it. */
async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project create", () => {
  test("scaffolds the project into a fresh directory named for the project", async () => {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent"]);

    // One existence check proves the handler→manager pipe; the full manifest
    // is covered by the FsProjectManager snapshot test.
    const projectRoot = join(directory, "MyAgent");
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).exists()).toBe(true);
  });

  test("rejects an invalid --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "1-bad"])).rejects.toThrow();
  });

  test("rejects a reserved --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "test"])).rejects.toThrow(/conflicts with/);
  });

  test("runs the post-scaffold steps and reports progress on stderr", async () => {
    const directory = await inTempDirectory();
    const { io, core } = await run(["create", "--name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello-world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
    expect(io.stderr()).toContain("Creating project tree");
    expect(io.stderr()).toContain("Installing CDK dependencies with npm");
    expect(io.stderr()).toContain("Syncing Python dependencies with uv");
    expect(io.stderr()).toContain("Initializing git repository");
    expect(io.stderr()).toContain("Created project 'MyAgent' in ./MyAgent");
  });

  test("--skip-install and --skip-git run no commands", async () => {
    await inTempDirectory();
    const { core } = await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    expect(core.projectCommands).toEqual([]);
  });

  test("rejects an unknown --template value", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "MyAgent", "--template", "nonsense"])).rejects.toThrow();
  });
});

describe("project add harness", () => {
  test.each([
    ["minimal — name only", ["--name", "my-agent"]],
    [
      "model — bedrock",
      [
        "--name",
        "x",
        "--model",
        '{"bedrockModelConfig":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}}',
      ],
    ],
    [
      "model — openai",
      [
        "--name",
        "x",
        "--model",
        '{"openAiModelConfig":{"modelId":"gpt-4","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}}',
      ],
    ],
    [
      "model — gemini",
      [
        "--name",
        "x",
        "--model",
        '{"geminiModelConfig":{"modelId":"gemini-pro","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}}',
      ],
    ],
    [
      "model — litellm",
      ["--name", "x", "--model", '{"liteLlmModelConfig":{"modelId":"anthropic/claude-3"}}'],
    ],
    [
      "tools — remote_mcp",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"remote_mcp","name":"mcp1","config":{"remoteMcp":{"url":"https://mcp.example.com"}}}]',
      ],
    ],
    [
      "tools — agentcore_gateway",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_gateway","name":"gw1","config":{"agentCoreGateway":{"gatewayArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/g"}}}]',
      ],
    ],
    [
      "tools — agentcore_browser",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_browser","name":"br1","config":{"agentCoreBrowser":{}}}]',
      ],
    ],
    [
      "tools — inline_function",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"inline_function","name":"fn1","config":{"inlineFunction":{"description":"test","inputSchema":{"type":"object"}}}}]',
      ],
    ],
    [
      "tools — agentcore_code_interpreter",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_code_interpreter","name":"ci1","config":{"agentCoreCodeInterpreter":{}}}]',
      ],
    ],
    [
      "tools — no config",
      ["--name", "x", "--tools", '[{"type":"agentcore_browser","name":"br1"}]'],
    ],
    [
      "tools — unrecognized config variant (passes through without config)",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_browser","name":"br1","config":{"someFutureConfig":{}}}]',
      ],
    ],
    ["skills — path", ["--name", "x", "--skills", '[{"path":"./my-skill"}]']],
    ["skills — s3", ["--name", "x", "--skills", '[{"s3":{"uri":"s3://bucket/skill/"}}]']],
    [
      "skills — git",
      [
        "--name",
        "x",
        "--skills",
        '[{"git":{"url":"https://github.com/org/repo","path":"skills/","auth":{"credentialArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:credential/c","username":"oauth2"}}}]',
      ],
    ],
    [
      "skills — awsSkills",
      ["--name", "x", "--skills", '[{"awsSkills":{"paths":["core-skills/*"]}}]'],
    ],
    [
      "memory — managed",
      [
        "--name",
        "x",
        "--memory",
        '{"managedMemoryConfiguration":{"strategies":["SEMANTIC"],"eventExpiryDuration":30}}',
      ],
    ],
    [
      "memory — existing",
      [
        "--name",
        "x",
        "--memory",
        '{"agentCoreMemoryConfiguration":{"arn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m"}}',
      ],
    ],
    ["memory — disabled", ["--name", "x", "--memory", '{"disabled":{}}']],
    [
      "truncation — sliding_window",
      [
        "--name",
        "x",
        "--truncation",
        '{"strategy":"sliding_window","config":{"slidingWindow":{"messagesCount":40}}}',
      ],
    ],
    [
      "truncation — summarization",
      [
        "--name",
        "x",
        "--truncation",
        '{"strategy":"summarization","config":{"summarization":{"summaryRatio":0.5,"preserveRecentMessages":5}}}',
      ],
    ],
    ["truncation — none", ["--name", "x", "--truncation", '{"strategy":"none"}']],
    [
      "truncation — unrecognized config variant (passes through strategy only)",
      ["--name", "x", "--truncation", '{"strategy":"none","config":{"someFutureStrategy":{}}}'],
    ],
    [
      "authorizer — customJWT",
      [
        "--name",
        "x",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["my-app"]}}',
      ],
    ],
    [
      "environment — VPC + lifecycle",
      [
        "--name",
        "x",
        "--environment",
        '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"VPC","networkModeConfig":{"subnets":["subnet-abc"],"securityGroups":["sg-abc"]}},"lifecycleConfiguration":{"idleRuntimeSessionTimeout":900,"maxLifetime":28800}}}',
      ],
    ],
    [
      "environment — with filesystem mounts",
      [
        "--name",
        "x",
        "--environment",
        '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"VPC","networkModeConfig":{"subnets":["subnet-abc"],"securityGroups":["sg-abc"]}},"filesystemConfigurations":[{"sessionStorage":{"mountPath":"/mnt/data"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-abc","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-abc/access-point/fsap-abc","mountPath":"/mnt/s3"}}]}}',
      ],
    ],
    [
      "environment-artifact — containerUri",
      [
        "--name",
        "x",
        "--environment-artifact",
        '{"containerConfiguration":{"containerUri":"123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest"}}',
      ],
    ],
    ["environment-variables", ["--name", "x", "--environment-variables", '{"LOG_LEVEL":"debug"}']],
    ["tags", ["--name", "x", "--tags", '{"team":"ml"}']],
    ["allowed-tools", ["--name", "x", "--allowed-tools", "*", "@builtin"]],
    [
      "max-iterations, max-tokens, timeout-seconds",
      ["--name", "x", "--max-iterations", "10", "--max-tokens", "4096", "--timeout-seconds", "60"],
    ],
  ])("%s", async (_label, flags) => {
    await inProject();
    // TODO: update to verify that the project updates.
    await expect(run(["add", "harness", ...flags])).rejects.toThrow("not yet implemented");
  });

  test.each([
    ["missing --name", ["--model", '{"bedrockModelConfig":{"modelId":"x"}}']],
    ["model without modelId", ["--name", "x", "--model", '{"bedrockModelConfig":{}}']],
    ["unrecognized model variant", ["--name", "x", "--model", '{"unknownConfig":{"modelId":"x"}}']],
    ["tool without type", ["--name", "x", "--tools", '[{"name":"t1"}]']],
    ["tool without name", ["--name", "x", "--tools", '[{"type":"remote_mcp"}]']],
    ["unrecognized skill variant", ["--name", "x", "--skills", '[{"unknown":true}]']],
    ["unrecognized memory variant", ["--name", "x", "--memory", '{"unknownMemory":{}}']],
    [
      "missing truncation strategy",
      ["--name", "x", "--truncation", '{"config":{"slidingWindow":{"messagesCount":10}}}'],
    ],
    [
      "unrecognized authorizer variant",
      ["--name", "x", "--authorizer-configuration", '{"unknownAuth":{}}'],
    ],
    [
      "missing discoveryUrl in authorizer",
      [
        "--name",
        "x",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"allowedAudience":["a"]}}',
      ],
    ],
    ["unrecognized environment variant", ["--name", "x", "--environment", '{"unknownEnv":{}}']],
    [
      "unrecognized environment-artifact variant",
      ["--name", "x", "--environment-artifact", '{"unknownArtifact":{}}'],
    ],
    [
      "containerUri and dockerfile are mutually exclusive",
      [
        "--name",
        "x",
        "--environment-artifact",
        '{"containerConfiguration":{"containerUri":"123456789012.dkr.ecr.us-east-1.amazonaws.com/img:v1"}}',
        "--dockerfile",
        "Dockerfile",
      ],
    ],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "harness", ...flags])).rejects.toBeInstanceOf(InputValidationError);
  });
});

describe("project build", () => {
  async function inBuildableProject(): Promise<string> {
    const projectRoot = await inProject("MyAgent");
    // create --skip-install leaves no node_modules, which build requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    return projectRoot;
  }

  test("synthesizes the CDK app of the enclosing project", async () => {
    const projectRoot = await inBuildableProject();
    const { io, core } = await run(["build"]);

    const cdkDir = join(projectRoot, "agentcore", "cdk");
    expect(core.projectCommands).toEqual([{ command: SYNTH(cdkDir), cwd: cdkDir }]);
    expect(io.stderr()).toContain("Synthesizing CloudFormation templates");
    expect(io.stderr()).toContain("Built project 'MyAgent'");
  });

  test("resolves the project from a nested directory", async () => {
    const projectRoot = await inBuildableProject();
    process.chdir(join(projectRoot, "app", "hello-world"));

    const { core } = await run(["build"]);

    expect(core.projectCommands.map(({ cwd }) => cwd)).toEqual([
      join(projectRoot, "agentcore", "cdk"),
    ]);
  });

  test("fails with actionable guidance outside a project", async () => {
    await inTempDirectory();
    await expect(run(["build"])).rejects.toThrow(/No AgentCore project found/);
  });

  test("fails when the CDK dependencies have not been installed", async () => {
    const projectRoot = await inBuildableProject();
    await rm(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });

    await expect(run(["build"])).rejects.toThrow(/npm install/);
  });
});

describe("project deploy", () => {
  // Scaffolds a project with one deployment target, then runs from inside it so
  // withProject resolves it. create() scaffolds an empty target list, which deploy
  // refuses, so the file is filled in here.
  async function inProject(): Promise<string> {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    const projectRoot = join(directory, "MyAgent");
    // create --skip-install leaves no node_modules, which the build step requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "default", account: "111122223333", region: "us-east-1" }]),
    );
    process.chdir(projectRoot);
    return projectRoot;
  }

  test("synthesizes, bootstraps, and deploys the enclosing project", async () => {
    const projectRoot = await inProject();
    const { io, core } = await run(["deploy"]);

    const cdkDir = join(projectRoot, "agentcore", "cdk");
    // Synthesis shells out; bootstrap and deploy go through the CDK toolkit, which
    // reads the assembly synthesis just wrote.
    expect(core.projectCommands).toEqual([{ command: SYNTH(cdkDir), cwd: cdkDir }]);
    const options = { assemblyDirectory: join(cdkDir, "cdk.out"), region: "us-east-1" };
    expect(core.cdkRuns).toEqual([
      { operation: { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] }, options },
      { operation: { kind: "deploy" }, options },
    ]);
    expect(io.stderr()).toContain("Bootstrapping aws://111122223333/us-east-1");
    expect(io.stderr()).toContain("Deploying stacks");
    expect(io.stderr()).toContain("Deployed project 'MyAgent'");
  });

  test("--skip-bootstrap deploys without bootstrapping", async () => {
    const projectRoot = await inProject();
    const { io, core } = await run(["deploy", "--skip-bootstrap"]);

    const cdkDir = join(projectRoot, "agentcore", "cdk");
    expect(core.projectCommands).toEqual([{ command: SYNTH(cdkDir), cwd: cdkDir }]);
    expect(core.cdkRuns.map(({ operation }) => operation)).toEqual([{ kind: "deploy" }]);
    expect(io.stderr()).not.toContain("Bootstrapping");
    expect(io.stderr()).toContain("Deployed project 'MyAgent'");
  });

  test("writes the CDK toolkit's own messages to stderr", async () => {
    await inProject();
    const { io } = await run(["deploy", "--skip-bootstrap"], (operation, emit) => {
      if (operation.kind === "deploy") {
        emit({ level: "info", message: "example-stack | 1/2 | CREATE_IN_PROGRESS" });
      }
    });

    expect(io.stderr()).toContain("example-stack | 1/2 | CREATE_IN_PROGRESS\n");
  });

  test("fails with actionable guidance when no targets are configured", async () => {
    const projectRoot = await inProject();
    await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), "[]");

    await expect(run(["deploy"])).rejects.toThrow(/aws-targets\.json/);
  });

  test("fails with actionable guidance outside a project", async () => {
    await inTempDirectory();
    await expect(run(["deploy"])).rejects.toThrow(/No AgentCore project found/);
  });
});
