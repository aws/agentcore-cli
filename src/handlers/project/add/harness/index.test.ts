import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { DeserializationError, InputValidationError } from "../../../../errors";
import { FsReadWriteJson, type ReadWriteJson } from "../../../../io";
import { HarnessYamlSchema } from "../../../../projectSchemas/harness";
import { credentialEnvVarName } from "../../../../projectSchemas/credential";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function run(args: string[], opts?: { core?: TestCoreClient; stdin?: string }) {
  const io = testIO({ stdin: opts?.stdin });
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", ...args]);
  return { io, core };
}

describe("project add harness", () => {
  const defaultModel = { provider: "bedrock", modelId: "global.anthropic.claude-sonnet-5-5" };

  test.each<[string, string[], Record<string, unknown>]>([
    ["minimal — name only", ["--name", "x"], { model: defaultModel }],
    [
      "model — bedrock",
      [
        "--name",
        "x",
        "--model",
        '{"provider":"bedrock","modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}',
      ],
      { model: { provider: "bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } },
    ],
    [
      "model — openai",
      [
        "--name",
        "x",
        "--model",
        '{"provider":"open_ai","modelId":"gpt-4","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}',
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
        '{"provider":"gemini","modelId":"gemini-pro","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}',
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
      ["--name", "x", "--model", '{"provider":"lite_llm","modelId":"anthropic/claude-3"}'],
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
      "skills — path",
      ["--name", "x", "--skills", '[{"path":"./my-skill"}]'],
      { skills: [{ path: "./my-skill" }] },
    ],
    [
      "skills — s3",
      ["--name", "x", "--skills", '[{"s3Uri":"s3://bucket/skill/"}]'],
      { skills: [{ s3Uri: "s3://bucket/skill/" }] },
    ],
    [
      "skills — git",
      [
        "--name",
        "x",
        "--skills",
        '[{"gitUrl":"https://github.com/org/repo","path":"skills/","auth":{"credentialArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:credential/c","username":"oauth2"}}]',
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
        '{"mode":"managed","strategies":["SEMANTIC"],"eventExpiryDuration":30}',
      ],
      { memory: { mode: "managed", strategies: ["SEMANTIC"], eventExpiryDuration: 30 } },
    ],
    [
      "memory — existing",
      [
        "--name",
        "x",
        "--memory",
        '{"mode":"existing","arn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m"}',
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
      ["--name", "x", "--memory", '{"mode":"disabled"}'],
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
      "authorizer — customJWT",
      [
        "--name",
        "x",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["my-app"]}}',
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
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--lifecycle-config",
        '{"idleRuntimeSessionTimeout":900,"maxLifetime":28800}',
        "--container-uri",
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest",
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
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
        "--session-storage-path",
        "/mnt/data",
        "--efs-access-points",
        '[{"accessPointArn":"arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0","mountPath":"/mnt/efs"}]',
        "--s3-access-points",
        '[{"accessPointArn":"arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef01","mountPath":"/mnt/s3"}]',
        "--container-uri",
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest",
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
      "container-uri",
      [
        "--name",
        "x",
        "--container-uri",
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest",
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
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(["add", "harness", ...flags]);

    const harnessYaml = parse(await Bun.file(join(projectRoot, "app", "x", "harness.yaml")).text());
    expect(HarnessYamlSchema.parse(harnessYaml)).toMatchObject(expected);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.harnesses).toContainEqual({
      name: "x",
      path: "app/x",
    });
  });

  test("--api-key stores the key under a project credential the model names", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    const keyPath = join(projectRoot, "key.txt");
    await Bun.write(keyPath, "sk-file\n");

    await run([
      "add",
      "harness",
      "--name",
      "x",
      "--model",
      '{"provider":"open_ai","modelId":"gpt-4"}',
      "--api-key",
      `file://${keyPath}`,
    ]);

    const harnessYaml = parse(await Bun.file(join(projectRoot, "app", "x", "harness.yaml")).text());
    expect(harnessYaml.model).toEqual({
      openAiModelConfig: { modelId: "gpt-4", apiKeyCredentialName: "xOpenAIApiKey" },
    });
    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "xOpenAIApiKey" },
    ]);
    const envLocal = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(envLocal).toContain(`${credentialEnvVarName("xOpenAIApiKey")}='sk-file'`);
  });

  test("--api-key reads the key from stdin", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(
      [
        "add",
        "harness",
        "--name",
        "x",
        "--model",
        '{"provider":"lite_llm","modelId":"anthropic/claude-3"}',
        "--api-key",
        "-",
      ],
      { stdin: "sk-stdin" },
    );
    const envLocal = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(envLocal).toContain(`${credentialEnvVarName("xLiteLLMApiKey")}='sk-stdin'`);
  });

  test.each<[string, string, RegExp]>([
    [
      "an apiKeyArn in --model",
      '{"provider":"open_ai","modelId":"gpt-4","apiKeyArn":"arn:aws:bedrock-agentcore:us-east-1:123456789012:api-key/k"}',
      /--api-key cannot be combined with apiKeyArn or apiKeyCredentialName in --model/,
    ],
    [
      "an apiKeyCredentialName in --model",
      '{"provider":"open_ai","modelId":"gpt-4","apiKeyCredentialName":"k"}',
      /--api-key cannot be combined with apiKeyArn or apiKeyCredentialName in --model/,
    ],
    [
      "a bedrock model",
      '{"provider":"bedrock","modelId":"m"}',
      /--api-key is not supported for the bedrock model provider/,
    ],
  ])("--api-key is refused with %s, before stdin is read", async (_label, model, expected) => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    const error = await run([
      "add",
      "harness",
      "--name",
      "x",
      "--model",
      model,
      "--api-key",
      "-",
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toMatch(expected);
    expect(existsSync(join(projectRoot, "app", "x"))).toBe(false);
  });

  test("a --model naming a credential the project lacks is refused", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(
      run([
        "add",
        "harness",
        "--name",
        "x",
        "--model",
        '{"provider":"open_ai","modelId":"gpt-4","apiKeyCredentialName":"missing"}',
      ]),
    ).rejects.toThrow("no credential named 'missing' exists in this project");
    expect(existsSync(join(projectRoot, "app", "x"))).toBe(false);
  });

  test("--system-prompt overrides the default system-prompt.md", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(["add", "harness", "--name", "x", "--system-prompt", "You are a pirate."]);

    const prompt = await Bun.file(join(projectRoot, "app", "x", "system-prompt.md")).text();
    expect(prompt).toBe("You are a pirate.");

    const harnessYaml = parse(await Bun.file(join(projectRoot, "app", "x", "harness.yaml")).text());
    expect(harnessYaml.systemPrompt).toBeUndefined();
    expect(harnessYaml.memory).toEqual({ managedMemoryConfiguration: {} });
    expect(harnessYaml.tools).toEqual([]);
    expect(harnessYaml.skills).toEqual([]);
    expect(existsSync(join(projectRoot, "app", "x", "harness.json"))).toBe(false);
  });

  test("--dockerfile copies the file into the harness directory and stores the relative path", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);

    const dockerfilePath = join(projectRoot, "Dockerfile");
    await Bun.write(dockerfilePath, "FROM python:3.12-slim\nCOPY . /app\n");

    await run(["add", "harness", "--name", "x", "--dockerfile", dockerfilePath]);

    const copiedContent = await Bun.file(join(projectRoot, "app", "x", "Dockerfile")).text();
    expect(copiedContent).toBe("FROM python:3.12-slim\nCOPY . /app\n");

    const harnessYaml = parse(await Bun.file(join(projectRoot, "app", "x", "harness.yaml")).text());
    expect(harnessYaml.dockerfile).toBe("Dockerfile");
  });

  test("--dockerfile with VPC mode succeeds when vpcId is in network-config", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);

    const dockerfilePath = join(projectRoot, "Dockerfile");
    await Bun.write(dockerfilePath, "FROM python:3.12-slim\n");

    await run([
      "add",
      "harness",
      "--name",
      "x",
      "--dockerfile",
      dockerfilePath,
      "--network-mode",
      "VPC",
      "--network-config",
      '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"],"vpcId":"vpc-0123456789abcdef0"}',
    ]);

    const harnessYaml = parse(await Bun.file(join(projectRoot, "app", "x", "harness.yaml")).text());
    expect(HarnessYamlSchema.parse(harnessYaml)).toMatchObject({
      dockerfile: "Dockerfile",
      networkMode: "VPC",
      networkConfig: {
        subnets: ["subnet-0123456789abcdef0"],
        securityGroups: ["sg-0123456789abcdef0"],
        vpcId: "vpc-0123456789abcdef0",
      },
    });
  });

  test("--dockerfile with VPC mode fails without vpcId in network-config", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);

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
        "--network-mode",
        "VPC",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
      ]),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("rejects a duplicate harness name", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(["add", "harness", "--name", "x"]);
    await expect(run(["add", "harness", "--name", "x"])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test("cleans up scaffolded files when the spec write fails", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    const logger = createSilentLogger();
    const realJson = new FsReadWriteJson({ logger });

    const failingJson: ReadWriteJson = {
      read: (path, schema) => realJson.read(path, schema),
      write: () => {
        throw new Error("simulated write failure");
      },
    };

    const core = new TestCoreClient({ json: failingJson });

    await expect(run(["add", "harness", "--name", "x"], { core })).rejects.toThrow();

    expect(existsSync(join(projectRoot, "app", "x"))).toBe(false);
  });

  test("rejects when the existing spec is invalid", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);

    const specPath = join(projectRoot, "agentcore", "agentcore.json");
    const spec = await Bun.file(specPath).json();
    spec.unknownField = "bad";
    await Bun.write(specPath, JSON.stringify(spec));

    await expect(run(["add", "harness", "--name", "x"])).rejects.toBeInstanceOf(
      DeserializationError,
    );
  });

  test.each<[string, string[], (string | typeof InputValidationError)?]>([
    ["missing --name", ["--model", '{"provider":"bedrock","modelId":"x"}']],
    [
      "deployed name over the 40-character service limit",
      ["--name", `h${"x".repeat(20)}`],
      `Harness deployed name 'TestProject_default_h${"x".repeat(20)}' is 41 characters. The maximum is 40.`,
    ],
    ["model without modelId", ["--name", "x", "--model", '{"provider":"bedrock"}']],
    [
      "unrecognized model provider",
      ["--name", "x", "--model", '{"provider":"unknown","modelId":"x"}'],
    ],
    ["tool without type", ["--name", "x", "--tools", '[{"name":"t1"}]']],
    ["tool without name", ["--name", "x", "--tools", '[{"type":"remote_mcp"}]']],
    ["unrecognized skill variant", ["--name", "x", "--skills", '[{"unknown":true}]']],
    ["unrecognized memory variant", ["--name", "x", "--memory", '{"mode":"unknown"}']],
    [
      "missing truncation strategy",
      ["--name", "x", "--truncation", '{"config":{"slidingWindow":{"messagesCount":10}}}'],
    ],
    [
      "authorizer config without matching type",
      [
        "--name",
        "x",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["a"]}}',
      ],
    ],
    [
      "missing discoveryUrl in authorizer",
      [
        "--name",
        "x",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"allowedAudience":["a"]}}',
      ],
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
        "--container-uri",
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/img:v1",
        "--dockerfile",
        "Dockerfile",
      ],
    ],
    [
      "networkConfig without VPC mode",
      [
        "--name",
        "x",
        "--network-config",
        '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}',
      ],
    ],
  ])("%s", async (_label, flags, expected = InputValidationError) => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(run(["add", "harness", ...flags])).rejects.toThrow(expected);
  });
});
