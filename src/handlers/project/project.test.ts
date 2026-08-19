import { afterEach, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { DeserializationError, InputValidationError } from "../../errors";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";

async function run(args: string[], opts?: { core?: TestCoreClient; stdin?: string }) {
  const io = testIO();
  // testIO's stdin is a PassThrough; pre-filling and ending it simulates piped input.
  if (opts?.stdin !== undefined) (io.io.stdin as unknown as PassThrough).end(opts.stdin);
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

describe.each(["remove", "deploy", "status"])("project %s", (command) => {
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

  test("rejects a duplicate harness name", async () => {
    await inProject();
    await run(["add", "harness", "--name", "x"]);
    await expect(run(["add", "harness", "--name", "x"])).rejects.toBeInstanceOf(
      InputValidationError,
    );
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

  test("rejects when the existing spec is invalid", async () => {
    const projectRoot = await inProject();

    // create a corrupted agentcore.json
    const specPath = join(projectRoot, "agentcore", "agentcore.json");
    const spec = await Bun.file(specPath).json();
    spec.unknownField = "bad";
    await Bun.write(specPath, JSON.stringify(spec));

    await expect(run(["add", "harness", "--name", "x"])).rejects.toBeInstanceOf(
      DeserializationError,
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

describe("project add credentials", () => {
  test("api-key with a file:// secret records the spec entry and stores the trailing-newline-stripped key in .env.local", async () => {
    const projectRoot = await inProject();
    const keyPath = join(projectRoot, "key.txt");
    // The trailing newline mirrors `echo` and editor output; it must not reach the value.
    await Bun.write(keyPath, "sk-123\n");

    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key",
      `file://${keyPath}`,
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key" },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=sk-123\n");
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SVC_KEY=sk-123\n\n");
  });

  test("api-key without a secret writes a commented placeholder and tells the user to fill it", async () => {
    const projectRoot = await inProject();
    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("# API key for credential provider 'svc-key' (set before deploy)");
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=\n");
    expect(io.stderr()).toContain(
      "Set AGENTCORE_CREDENTIAL_SVC_KEY in agentcore/.env.local before you deploy",
    );
  });

  test("api-key with an external secret reference records it in the spec and skips .env.local", async () => {
    const projectRoot = await inProject();
    const secretRef = {
      secretId: "arn:aws:secretsmanager:us-west-2:123456789012:secret:s",
      jsonKey: "apiKey",
    };

    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key-secret-reference",
      JSON.stringify(secretRef),
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key", secretRef },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SVC_KEY");
  });

  const discoveryUrl = "https://idp.example.com/.well-known/openid-configuration";

  test("oauth custom with guided flags and a stdin secret records the spec entry and the secret", async () => {
    const projectRoot = await inProject();

    await run(
      [
        "add",
        "credentials",
        "oauth",
        "--name",
        "idp",
        "--discovery-url",
        discoveryUrl,
        "--client-id",
        "client-1",
        "--scopes",
        "openid",
        "email",
        "--client-secret",
        "-",
      ],
      { stdin: "sssh" },
    );

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "idp",
        vendor: "CustomOauth2",
        clientId: "client-1",
        discoveryUrl,
        scopes: ["openid", "email"],
      },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_IDP_CLIENT_SECRET=sssh");
  });

  test("oauth vendored with --provider-configuration records the config and a secret placeholder", async () => {
    const projectRoot = await inProject();

    const { io } = await run([
      "add",
      "credentials",
      "oauth",
      "--name",
      "github",
      "--vendor",
      "GithubOauth2",
      "--provider-configuration",
      '{"githubOauth2ProviderConfig":{"clientId":"client-1"}}',
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        vendor: "GithubOauth2",
        providerConfig: { githubOauth2ProviderConfig: { clientId: "client-1" } },
      },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET=\n");
    expect(io.stderr()).toContain(
      "Set AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET in agentcore/.env.local before you deploy",
    );
  });

  test("preserves existing .env.local content and never overwrites an existing key", async () => {
    const projectRoot = await inProject();
    const envPath = join(projectRoot, "agentcore", ".env.local");
    const original = await Bun.file(envPath).text();
    await Bun.write(envPath, `${original}AGENTCORE_CREDENTIAL_SVC_KEY=user-managed\n`);

    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(envPath).text();
    expect(env).toStartWith(original);
    expect(env.match(/AGENTCORE_CREDENTIAL_SVC_KEY=/g)).toHaveLength(1);
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=user-managed");
    expect(io.stderr()).toContain("already exists");
  });

  test("restores the .gitignore .env.local entry when the project lost it", async () => {
    const projectRoot = await inProject();
    await Bun.write(join(projectRoot, ".gitignore"), "node_modules/\n");

    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const gitignore = await Bun.file(join(projectRoot, ".gitignore")).text();
    expect(gitignore).toStartWith("node_modules/\n");
    expect(gitignore).toContain("\n.env.local\n");
    expect(io.stderr()).toContain(".gitignore");
  });

  test("rejects a duplicate credential name across credential types", async () => {
    await inProject();
    await run(["add", "credentials", "api-key", "--name", "x"]);
    await expect(
      run(["add", "credentials", "oauth", "--name", "x", "--discovery-url", discoveryUrl]),
    ).rejects.toThrow(/already exists/);
  });

  test.each<[string, string[], RegExp]>([
    [
      "api-key: an inline secret value",
      ["api-key", "--name", "x", "--api-key", "sk-inline"],
      /file:\/\//,
    ],
    ["api-key: a multi-line secret", ["api-key", "--name", "x", "--api-key", "-"], /single-line/],
    [
      "oauth: an inline secret value",
      ["oauth", "--name", "x", "--discovery-url", discoveryUrl, "--client-secret", "sssh"],
      /file:\/\//,
    ],
    [
      "api-key: a secret combined with a secret reference",
      [
        "api-key",
        "--name",
        "x",
        "--api-key",
        "-",
        "--api-key-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey"}',
      ],
      /mutually exclusive/,
    ],
    [
      "oauth: a secret combined with a secret reference",
      [
        "oauth",
        "--name",
        "x",
        "--discovery-url",
        discoveryUrl,
        "--client-secret",
        "-",
        "--client-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"clientSecret"}',
      ],
      /mutually exclusive/,
    ],
    ["api-key: a missing --name", ["api-key"], /--name/],
    ["oauth: a missing --name", ["oauth"], /--name/],
    [
      "oauth: a vendored provider without --provider-configuration",
      ["oauth", "--name", "x", "--vendor", "GithubOauth2"],
      /--provider-configuration/,
    ],
    [
      "oauth: a guided custom provider without --discovery-url",
      ["oauth", "--name", "x", "--client-id", "c"],
      /--discovery-url/,
    ],
    [
      "oauth: --provider-configuration combined with --scopes",
      [
        "oauth",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--provider-configuration",
        '{"githubOauth2ProviderConfig":{"clientId":"c"}}',
        "--scopes",
        "repo",
      ],
      /mutually exclusive/,
    ],
    [
      "oauth: secret material inside --provider-configuration",
      [
        "oauth",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--provider-configuration",
        '{"githubOauth2ProviderConfig":{"clientId":"c","clientSecret":"sssh"}}',
      ],
      /secret material/,
    ],
  ])("rejects %s", async (_label, args, message) => {
    await inProject();
    await expect(run(["add", "credentials", ...args], { stdin: "line1\nline2" })).rejects.toThrow(
      message,
    );
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

    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "run", "cdk", "--", "synth", "--quiet"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
    ]);
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
