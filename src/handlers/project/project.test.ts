import { afterEach, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
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
import { FsReadWriteJson, type CdkEvent, type CdkOperation, type ReadWriteJson } from "../../io";
import { detailedLogLocation } from "../../logging";

// The synth command build and deploy both issue. --output pins the assembly to the
// directory deploy reads, so cdk.json's own `output` cannot send the two apart.
function SYNTH(cdkDir: string): string[] {
  return ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", join(cdkDir, "cdk.out")];
}

// How the generated CDK app names the stack it synthesizes for a target.
function STACK(target: string): string {
  return `AgentCore-MyAgent-${target}`;
}

type CliOptions = {
  /** Stands in for driving the CDK toolkit; see {@link TestCoreClient}. */
  onCdkOperation?: (operation: CdkOperation, emit: (event: CdkEvent) => void) => void;
  /** An already-wired client, for a test that needs one of its doubles to fail. */
  core?: TestCoreClient;
  /** The outputs the deployed stack reports; see {@link TestCoreClient}. */
  cdkOutputs?: Record<string, string>;
};

// A CLI wired to test doubles, whose route() a test drives directly when it needs
// what was written after a command failed.
function cli(options?: CliOptions) {
  const io = testIO();
  const core =
    options?.core ??
    new TestCoreClient({
      onCdkOperation: options?.onCdkOperation,
      cdkOutputs: options?.cdkOutputs,
    });
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return {
    io,
    core,
    route: (args: string[]) => root.route(["node", "agentcore", "project", ...args]),
  };
}

async function run(args: string[], options?: CliOptions) {
  const { io, core, route } = cli(options);
  await route(args);
  return { io, core };
}

describe.each(["remove", "status"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
});

test("project dev requires an AgentCore project", async () => {
  await inTempDirectory();
  await expect(run(["dev"])).rejects.toThrow(/No AgentCore project found/);
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
  const defaultModel = { provider: "bedrock", modelId: "global.anthropic.claude-sonnet-4-6" };
  /** Verify error case for different flags **/
  test.each<[string, string[], Record<string, unknown>]>([
    ["minimal — name only", ["--name", "x"], { model: defaultModel }],
    [
      "model — bedrock",
      [
        "--name",
        "x",
        "--model",
        '{"bedrockModelConfig":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}}',
      ],
      { model: { provider: "bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } },
    ],
    [
      "model — openai",
      [
        "--name",
        "x",
        "--model",
        '{"openAiModelConfig":{"modelId":"gpt-4","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}}',
      ],
      {
        model: {
          provider: "open_ai",
          modelId: "gpt-4",
          apiKeyArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k",
        },
      },
    ],
    [
      "model — gemini",
      [
        "--name",
        "x",
        "--model",
        '{"geminiModelConfig":{"modelId":"gemini-pro","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}}',
      ],
      {
        model: {
          provider: "gemini",
          modelId: "gemini-pro",
          apiKeyArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k",
        },
      },
    ],
    [
      "model — litellm",
      ["--name", "x", "--model", '{"liteLlmModelConfig":{"modelId":"anthropic/claude-3"}}'],
      { model: { provider: "lite_llm", modelId: "anthropic/claude-3" } },
    ],
    [
      "tools — remote_mcp",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"remote_mcp","name":"mcp1","config":{"remoteMcp":{"url":"https://mcp.example.com"}}}]',
      ],
      {
        tools: [
          {
            type: "remote_mcp",
            name: "mcp1",
            config: { remoteMcp: { url: "https://mcp.example.com" } },
          },
        ],
      },
    ],
    [
      "tools — agentcore_gateway",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_gateway","name":"gw1","config":{"agentCoreGateway":{"gatewayArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/g"}}}]',
      ],
      {
        tools: [
          {
            type: "agentcore_gateway",
            name: "gw1",
            config: {
              agentCoreGateway: {
                gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/g",
              },
            },
          },
        ],
      },
    ],
    [
      "tools — agentcore_gateway with outboundAuth",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_gateway","name":"gw1","config":{"agentCoreGateway":{"gatewayArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/g","outboundAuth":{"oauth":{"providerArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:oauth2-credential-provider/p","scopes":["read","write"]}}}}}]',
      ],
      {
        tools: [
          {
            type: "agentcore_gateway",
            name: "gw1",
            config: {
              agentCoreGateway: {
                gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/g",
                outboundAuth: {
                  oauth: {
                    providerArn:
                      "arn:aws:bedrock-agentcore:us-east-1:123456789012:oauth2-credential-provider/p",
                    scopes: ["read", "write"],
                  },
                },
              },
            },
          },
        ],
      },
    ],
    [
      "tools — agentcore_browser",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_browser","name":"br1","config":{"agentCoreBrowser":{}}}]',
      ],
      { tools: [{ type: "agentcore_browser", name: "br1", config: { agentCoreBrowser: {} } }] },
    ],
    [
      "tools — inline_function",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"inline_function","name":"fn1","config":{"inlineFunction":{"description":"test","inputSchema":{"type":"object"}}}}]',
      ],
      {
        tools: [
          {
            type: "inline_function",
            name: "fn1",
            config: { inlineFunction: { description: "test", inputSchema: { type: "object" } } },
          },
        ],
      },
    ],
    [
      "tools — agentcore_code_interpreter",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_code_interpreter","name":"ci1","config":{"agentCoreCodeInterpreter":{}}}]',
      ],
      {
        tools: [
          {
            type: "agentcore_code_interpreter",
            name: "ci1",
            config: { agentCoreCodeInterpreter: {} },
          },
        ],
      },
    ],
    [
      "tools — no config",
      ["--name", "x", "--tools", '[{"type":"agentcore_browser","name":"br1"}]'],
      { tools: [{ type: "agentcore_browser", name: "br1" }] },
    ],
    [
      "tools — unrecognized config variant (passes through without config)",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_browser","name":"br1","config":{"someFutureConfig":{}}}]',
      ],
      { tools: [{ type: "agentcore_browser", name: "br1" }] },
    ],
    [
      "skills — path",
      ["--name", "x", "--skills", '[{"path":"./my-skill"}]'],
      { skills: [{ path: "./my-skill" }] },
    ],
    [
      "skills — s3",
      ["--name", "x", "--skills", '[{"s3":{"uri":"s3://bucket/skill/"}}]'],
      { skills: [{ s3Uri: "s3://bucket/skill/" }] },
    ],
    [
      "skills — git",
      [
        "--name",
        "x",
        "--skills",
        '[{"git":{"url":"https://github.com/org/repo","path":"skills/","auth":{"credentialArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:credential/c","username":"oauth2"}}}]',
      ],
      {
        skills: [
          {
            gitUrl: "https://github.com/org/repo",
            path: "skills/",
            auth: {
              credentialArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:credential/c",
              username: "oauth2",
            },
          },
        ],
      },
    ],
    [
      "skills — awsSkills",
      ["--name", "x", "--skills", '[{"awsSkills":{"paths":["core-skills/*"]}}]'],
      { skills: [{ awsSkills: { paths: ["core-skills/*"] } }] },
    ],
    [
      "memory — managed",
      [
        "--name",
        "x",
        "--memory",
        '{"managedMemoryConfiguration":{"strategies":["SEMANTIC"],"eventExpiryDuration":30}}',
      ],
      { memory: { mode: "managed", strategies: ["SEMANTIC"], eventExpiryDuration: 30 } },
    ],
    [
      "memory — existing",
      [
        "--name",
        "x",
        "--memory",
        '{"agentCoreMemoryConfiguration":{"arn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m"}}',
      ],
      {
        memory: {
          mode: "existing",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m",
        },
      },
    ],
    [
      "memory — disabled",
      ["--name", "x", "--memory", '{"disabled":{}}'],
      { memory: { mode: "disabled" } },
    ],
    [
      "truncation — sliding_window",
      [
        "--name",
        "x",
        "--truncation",
        '{"strategy":"sliding_window","config":{"slidingWindow":{"messagesCount":40}}}',
      ],
      {
        truncation: {
          strategy: "sliding_window",
          config: { slidingWindow: { messagesCount: 40 } },
        },
      },
    ],
    [
      "truncation — summarization",
      [
        "--name",
        "x",
        "--truncation",
        '{"strategy":"summarization","config":{"summarization":{"summaryRatio":0.5,"preserveRecentMessages":5}}}',
      ],
      {
        truncation: {
          strategy: "summarization",
          config: { summarization: { summaryRatio: 0.5, preserveRecentMessages: 5 } },
        },
      },
    ],
    [
      "truncation — none",
      ["--name", "x", "--truncation", '{"strategy":"none"}'],
      { truncation: { strategy: "none" } },
    ],
    [
      "truncation — unrecognized config variant (passes through strategy only)",
      ["--name", "x", "--truncation", '{"strategy":"none","config":{"someFutureStrategy":{}}}'],
      { truncation: { strategy: "none" } },
    ],
    [
      "authorizer — customJWT",
      [
        "--name",
        "x",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["my-app"]}}',
      ],
      {
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
            allowedAudience: ["my-app"],
          },
        },
      },
    ],
    [
      "environment — VPC + lifecycle",
      [
        "--name",
        "x",
        "--environment",
        '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"VPC","networkModeConfig":{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}},"lifecycleConfiguration":{"idleRuntimeSessionTimeout":900,"maxLifetime":28800}}}',
      ],
      {
        networkMode: "VPC",
        networkConfig: {
          subnets: ["subnet-0123456789abcdef0"],
          securityGroups: ["sg-0123456789abcdef0"],
        },
        lifecycleConfig: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
      },
    ],
    [
      "environment — with filesystem mounts",
      [
        "--name",
        "x",
        "--environment",
        '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"VPC","networkModeConfig":{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}},"filesystemConfigurations":[{"sessionStorage":{"mountPath":"/mnt/data"}},{"efsAccessPoint":{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}},{"s3FilesAccessPoint":{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef01","mountPath":"/mnt/s3"}}]}}',
      ],
      {
        networkMode: "VPC",
        networkConfig: {
          subnets: ["subnet-0123456789abcdef0"],
          securityGroups: ["sg-0123456789abcdef0"],
        },
        sessionStoragePath: "/mnt/data",
        efsAccessPoints: [
          {
            accessPointArn:
              "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
            mountPath: "/mnt/efs",
          },
        ],
        s3AccessPoints: [
          {
            accessPointArn:
              "arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef01",
            mountPath: "/mnt/s3",
          },
        ],
      },
    ],
    [
      "environment-artifact — containerUri",
      [
        "--name",
        "x",
        "--environment-artifact",
        '{"containerConfiguration":{"containerUri":"123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest"}}',
      ],
      { containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest" },
    ],
    [
      "environment-variables",
      ["--name", "x", "--environment-variables", '{"LOG_LEVEL":"debug"}'],
      { environmentVariables: { LOG_LEVEL: "debug" } },
    ],
    ["tags", ["--name", "x", "--tags", '{"team":"ml"}'], { tags: { team: "ml" } }],
    [
      "allowed-tools",
      ["--name", "x", "--allowed-tools", "*", "@builtin"],
      { allowedTools: ["*", "@builtin"] },
    ],
    [
      "max-iterations, max-tokens, timeout-seconds",
      ["--name", "x", "--max-iterations", "10", "--max-tokens", "4096", "--timeout-seconds", "60"],
      { maxIterations: 10, maxTokens: 4096, timeoutSeconds: 60 },
    ],
  ])("%s", async (_label, flags, expected) => {
    const projectRoot = await inProject();
    await run(["add", "harness", ...flags]);

    const harnessJson = await Bun.file(join(projectRoot, "app", "x", "harness.json")).json();
    expect(harnessJson).toMatchObject(expected);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.harnesses).toContainEqual({
      name: "x",
      path: join("app", "x"),
    });
  });

  test("--system-prompt overrides the default system-prompt.md", async () => {
    const projectRoot = await inProject();
    await run(["add", "harness", "--name", "x", "--system-prompt", "You are a pirate."]);

    const prompt = await Bun.file(join(projectRoot, "app", "x", "system-prompt.md")).text();
    expect(prompt).toBe("You are a pirate.");

    const harnessJson = await Bun.file(join(projectRoot, "app", "x", "harness.json")).json();
    expect(harnessJson).not.toHaveProperty("systemPrompt");
  });

  test("--dockerfile copies the file into the harness directory and stores the relative path", async () => {
    const projectRoot = await inProject();

    const dockerfilePath = join(projectRoot, "Dockerfile");
    await Bun.write(dockerfilePath, "FROM python:3.12-slim\nCOPY . /app\n");

    await run(["add", "harness", "--name", "x", "--dockerfile", dockerfilePath]);

    const copiedContent = await Bun.file(join(projectRoot, "app", "x", "Dockerfile")).text();
    expect(copiedContent).toBe("FROM python:3.12-slim\nCOPY . /app\n");

    const harnessJson = await Bun.file(join(projectRoot, "app", "x", "harness.json")).json();
    expect(harnessJson.dockerfile).toBe("Dockerfile");
  });

  test("--dockerfile with VPC mode succeeds when --vpc-id is provided", async () => {
    const projectRoot = await inProject();

    const dockerfilePath = join(projectRoot, "Dockerfile");
    await Bun.write(dockerfilePath, "FROM python:3.12-slim\n");

    await run([
      "add",
      "harness",
      "--name",
      "x",
      "--dockerfile",
      dockerfilePath,
      "--environment",
      '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"VPC","networkModeConfig":{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}}}}',
      "--vpc-id",
      "vpc-0123456789abcdef0",
    ]);

    const harnessJson = await Bun.file(join(projectRoot, "app", "x", "harness.json")).json();
    expect(harnessJson).toMatchObject({
      dockerfile: "Dockerfile",
      networkMode: "VPC",
      networkConfig: {
        subnets: ["subnet-0123456789abcdef0"],
        securityGroups: ["sg-0123456789abcdef0"],
        vpcId: "vpc-0123456789abcdef0",
      },
    });
  });

  test("--dockerfile with VPC mode fails without --vpc-id", async () => {
    const projectRoot = await inProject();

    const dockerfilePath = join(projectRoot, "Dockerfile");
    await Bun.write(dockerfilePath, "FROM python:3.12-slim\n");

    await expect(
      run([
        "add",
        "harness",
        "--name",
        "x",
        "--dockerfile",
        dockerfilePath,
        "--environment",
        '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"VPC","networkModeConfig":{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}}}}',
      ]),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("cleans up scaffolded files when the spec write fails", async () => {
    const projectRoot = await inProject();
    const logger = createSilentLogger();
    const realJson = new FsReadWriteJson({ logger });

    // A json adapter that delegates reads but always fails on write.
    const failingJson: ReadWriteJson = {
      read: (path, schema) => realJson.read(path, schema),
      write: () => {
        throw new Error("simulated write failure");
      },
    };

    const core = new TestCoreClient({ json: failingJson });

    await expect(run(["add", "harness", "--name", "x"], { core })).rejects.toThrow();

    // The scaffolded harness directory should have been cleaned up.
    expect(existsSync(join(projectRoot, "app", "x"))).toBe(false);
  });

  test("rejects a duplicate harness name", async () => {
    await inProject();
    await run(["add", "harness", "--name", "x"]);
    await expect(run(["add", "harness", "--name", "x"])).rejects.toBeInstanceOf(
      InputValidationError,
    );
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
      "unrecognized outboundAuth variant",
      [
        "--name",
        "x",
        "--tools",
        '[{"type":"agentcore_gateway","name":"gw1","config":{"agentCoreGateway":{"gatewayArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/g","outboundAuth":{"unknownAuth":{}}}}}]',
      ],
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
    [
      "--vpc-id requires --environment with VPC network configuration",
      ["--name", "x", "--vpc-id", "vpc-0123456789abcdef0"],
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
  async function inProject(
    targets = [{ name: "default", account: "111122223333", region: "us-east-1" }],
  ): Promise<string> {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    const projectRoot = join(directory, "MyAgent");
    // create --skip-install leaves no node_modules, which the build step requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    await writeFile(join(projectRoot, "agentcore", "aws-targets.json"), JSON.stringify(targets));
    // Synthesis is stubbed here, so stand in for the assembly it would have written:
    // deploy reads the manifest to find the stack belonging to the target.
    const assembly = join(projectRoot, "agentcore", "cdk", "cdk.out");
    await mkdir(assembly, { recursive: true });
    await writeFile(
      join(assembly, "manifest.json"),
      JSON.stringify({
        artifacts: Object.fromEntries(
          targets.map(({ name }) => [
            STACK(name),
            {
              type: "aws:cloudformation:stack",
              properties: { tags: { "agentcore:target-name": name } },
            },
          ]),
        ),
      }),
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
      { operation: { kind: "deploy", stackName: STACK("default") }, options },
    ]);
    expect(io.stderr()).toContain("Bootstrapping aws://111122223333/us-east-1");
    expect(io.stderr()).toContain(`Deploying ${STACK("default")}`);
    expect(io.stderr()).toContain("Deployed project 'MyAgent'");
  });

  test("--target selects which configured target to deploy to", async () => {
    const projectRoot = await inProject([
      { name: "default", account: "111122223333", region: "us-east-1" },
      { name: "prod", account: "444455556666", region: "eu-west-1" },
    ]);
    const { io, core } = await run(["deploy", "--target", "prod"]);

    const cdkDir = join(projectRoot, "agentcore", "cdk");
    expect(core.projectCommands).toEqual([{ command: SYNTH(cdkDir), cwd: cdkDir }]);
    expect(core.cdkRuns.map(({ operation }) => operation)).toEqual([
      { kind: "bootstrap", environments: ["aws://444455556666/eu-west-1"] },
      { kind: "deploy", stackName: STACK("prod") },
    ]);
    expect(io.stderr()).toContain("Deployed project 'MyAgent'");
  });

  test("fails with actionable guidance when --target names no configured target", async () => {
    await inProject();

    await expect(run(["deploy", "--target", "prod"])).rejects.toThrow(
      /no deployment target named 'prod'/,
    );
  });

  test("prints the deployed stack's outputs with the result", async () => {
    await inProject();
    const { io } = await run(["deploy"], {
      cdkOutputs: {
        RuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/MyAgent",
        GatewayUrl: "https://example.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      },
    });

    // What the deploy created is the reason to read the end of one: the ARNs and URLs
    // the user's next command needs, listed after the line saying it worked.
    expect(io.stderr()).toContain(
      "Deployed project 'MyAgent'\n" +
        "  GatewayUrl: https://example.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp\n" +
        "  RuntimeArn: arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/MyAgent\n",
    );
  });

  test("prints no outputs for a stack that declares none", async () => {
    await inProject();
    const { io } = await run(["deploy"]);

    // Nothing between the result and the log location, rather than an empty heading.
    expect(io.stderr()).toContain(
      `Deployed project 'MyAgent'\nDetailed logs: ${detailedLogLocation()}`,
    );
  });

  test("keeps the CDK toolkit's own messages off screen, naming the log instead", async () => {
    await inProject();
    const { io } = await run(["deploy"], {
      onCdkOperation: (operation, emit) => {
        if (operation.kind === "deploy") {
          emit({ level: "info", message: "example-stack | 1/2 | CREATE_IN_PROGRESS" });
        }
      },
    });

    // A deploy shows its steps; the toolkit's narration is in the log, so the
    // location is the last thing printed.
    expect(io.stderr()).not.toContain("CREATE_IN_PROGRESS");
    expect(io.stderr()).toEndWith(`Detailed logs: ${detailedLogLocation()}`);
  });

  test("names the log even when the deploy fails", async () => {
    await inProject();
    const { io, route } = cli({
      onCdkOperation: (operation) => {
        if (operation.kind === "deploy") throw new Error("cdk deploy exploded");
      },
    });

    await expect(route(["deploy"])).rejects.toThrow("cdk deploy exploded");

    // The failure is when the log matters most: it holds the toolkit's account of
    // what went wrong, which the error itself does not carry.
    expect(io.stderr()).toContain(`Detailed logs: ${detailedLogLocation()}`);
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
