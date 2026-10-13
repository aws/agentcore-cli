import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessSpecSchema, HarnessYamlSchema } from "../../../projectSchemas/harness";
import { canonical, convertHarness, harnessJsonToYaml } from "./convertHarness";
import { F1_HARNESS } from "./migrate-test-support";

const FILE = "app/h/harness.json";
const SUBNET = "subnet-0123456789abcdef0";
const SG = "sg-0123456789abcdef0";
const EFS = "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0";
const S3_FILES =
  "arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef0/access-point/fsap-0123456789abcdef0";

/** harness.json shapes v0 0.31.1 accepted, from the minimal scaffold to every optional field. */
const HARNESSES: Record<string, Record<string, unknown>> = {
  "the scaffolded default": F1_HARNESS,
  "a fully configured harness": {
    name: "full",
    model: {
      provider: "open_ai",
      modelId: "gpt-5",
      apiKeyArn:
        "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/k",
      apiFormat: "responses",
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 4096,
    },
    systemPrompt: "You are helpful.\nAnswer briefly.",
    tools: [
      {
        type: "remote_mcp",
        name: "research",
        config: { remoteMcp: { url: "https://mcp.example.com/mcp", headers: { a: "b" } } },
      },
      { type: "agentcore_browser", name: "browser" },
      { type: "agentcore_code_interpreter", name: "ci", config: { agentCoreCodeInterpreter: {} } },
      {
        type: "agentcore_gateway",
        name: "gw",
        config: { agentCoreGateway: { gatewayArn: "arn:gw", outboundAuth: { awsIam: {} } } },
      },
      {
        type: "inline_function",
        name: "fn",
        config: { inlineFunction: { description: "d", inputSchema: { type: "object" } } },
      },
    ],
    skills: [
      "./skills/local",
      { path: "skills/other" },
      { s3Uri: "s3://bucket/skills" },
      { gitUrl: "https://github.com/org/skills", path: "sub", auth: { credentialName: "gh" } },
      { awsSkills: { paths: ["core-skills/aws-serverless"] } },
    ],
    allowedTools: ["*"],
    memory: { mode: "managed", strategies: ["SEMANTIC"], eventExpiryDuration: 30 },
    maxIterations: 10,
    maxTokens: 2000,
    timeoutSeconds: 300,
    truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 20 } } },
    containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/harness:latest",
    executionRoleArn: "arn:aws:iam::123456789012:role/harness",
    networkMode: "VPC",
    networkConfig: { subnets: [SUBNET], securityGroups: [SG], vpcId: "vpc-0123456789abcdef0" },
    lifecycleConfig: { idleRuntimeSessionTimeout: 900, maxLifetime: 3600 },
    sessionStoragePath: "/mnt/session",
    efsAccessPoints: [{ accessPointArn: EFS, mountPath: "/mnt/efs" }],
    s3AccessPoints: [{ accessPointArn: S3_FILES, mountPath: "/mnt/s3" }],
    environmentVariables: { LOG_LEVEL: "debug" },
    authorizerType: "CUSTOM_JWT",
    authorizerConfiguration: {
      customJwtAuthorizer: {
        discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
        allowedClients: ["cli"],
      },
    },
    connections: [
      {
        id: "mem",
        to: { type: "memory", arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1" },
        access: "read",
      },
    ],
    tags: { team: "x" },
  },
  "an existing memory and a dockerfile": {
    name: "existing",
    model: {
      provider: "lite_llm",
      modelId: "bedrock/x",
      apiBase: "https://llm.example.com",
      additionalParams: { a: 1 },
    },
    memory: {
      name: "projectMemory",
      actorId: "user",
      messagesCount: 5,
      retrievalConfig: { topK: 3 },
    },
    dockerfile: "Dockerfile",
    networkMode: "PUBLIC",
    truncation: { strategy: "none" },
  },
  "a gemini model with session storage only": {
    name: "gem",
    model: { provider: "gemini", modelId: "gemini-x", apiKeyArn: "arn:k", topK: 10 },
    sessionStoragePath: "/mnt/data",
    memory: {
      mode: "existing",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1",
    },
  },
};

describe("harnessJsonToYaml", () => {
  test.each(Object.entries(HARNESSES))("round-trips %s through harness.yaml", (_label, json) => {
    const { yaml, problems } = harnessJsonToYaml(json, FILE);
    expect(problems).toEqual([]);
    if (yaml === undefined) throw new Error("expected harness.yaml content");
    expect(yaml).toStartWith("# Harness configuration:");
    const decoded = HarnessYamlSchema.parse(parse(yaml));
    expect(canonical(decoded)).toEqual(canonical(HarnessSpecSchema.parse(json)));
  });

  test("writes the API-shaped nested form", () => {
    const { yaml } = harnessJsonToYaml(HARNESSES["a fully configured harness"], FILE);
    const doc = parse(yaml!) as Record<string, unknown>;
    expect(doc.model).toEqual({
      openAiModelConfig: expect.objectContaining({ modelId: "gpt-5" }),
    });
    expect(doc.systemPrompt).toEqual([{ text: "You are helpful.\nAnswer briefly." }]);
    expect(doc.memory).toEqual({
      managedMemoryConfiguration: { strategies: ["SEMANTIC"], eventExpiryDuration: 30 },
    });
    expect(doc.environmentArtifact).toEqual({
      containerConfiguration: {
        containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/harness:latest",
      },
    });
    expect(doc.networkConfig).toEqual({ vpcId: "vpc-0123456789abcdef0" });
    expect(doc.environment).toEqual({
      agentCoreRuntimeEnvironment: {
        networkConfiguration: {
          networkMode: "VPC",
          networkModeConfig: { subnets: [SUBNET], securityGroups: [SG] },
        },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 3600 },
        filesystemConfigurations: [
          { sessionStorage: { mountPath: "/mnt/session" } },
          { efsAccessPoint: { accessPointArn: EFS, mountPath: "/mnt/efs" } },
          { s3FilesAccessPoint: { accessPointArn: S3_FILES, mountPath: "/mnt/s3" } },
        ],
      },
    });
    expect(doc.authorizerConfiguration).toEqual({
      customJWTAuthorizer: expect.objectContaining({ allowedClients: ["cli"] }),
    });
    expect("authorizerType" in doc).toBe(false);
  });

  test("omits fields the harness doesn't set", () => {
    const doc = parse(harnessJsonToYaml(F1_HARNESS, FILE).yaml!) as Record<string, unknown>;
    expect(doc).toEqual({
      name: "CompatAHarness",
      model: { bedrockModelConfig: { modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } },
      tools: [],
      skills: [],
      memory: { disabled: {} },
    });
  });

  test("reports a harness.json v0 itself rejects, with the field path", () => {
    const { yaml, problems } = harnessJsonToYaml({ name: "h", model: { provider: "nope" } }, FILE);
    expect(yaml).toBeUndefined();
    expect(problems.map((problem) => `${problem.file} ${problem.path}`)).toContain(
      `${FILE} model.provider`,
    );
  });
});

describe("convertHarness", () => {
  const roots: string[] = [];
  afterEach(() => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));

  async function root(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentcore-harness-"));
    roots.push(dir);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }

  test("reads the entry's harness.json and normalizes its directory", async () => {
    const dir = await root({ "app/h/harness.json": JSON.stringify(F1_HARNESS) });
    const result = await convertHarness(dir, { name: "h", path: "./app/h/" });
    expect(result.directory).toBe("app/h");
    expect(result.problems).toEqual([]);
    expect(result.yaml).toContain("bedrockModelConfig");
  });

  test.each(["../outside", "/abs/harness", "app/../../outside"])(
    "refuses a harness path outside the project: %s",
    async (path) => {
      const result = await convertHarness(await root({}), { name: "h", path });
      expect(result.yaml).toBeUndefined();
      expect(result.problems).toEqual([
        {
          file: "agentcore/agentcore.json",
          path: "harnesses[h].path",
          message: `'${path}' is outside the project; move the harness into the project first`,
        },
      ]);
    },
  );

  test("returns the harness facts the pins depend on", async () => {
    const dir = await root({
      "app/h/harness.json": JSON.stringify({
        ...F1_HARNESS,
        dockerfile: "Dockerfile",
        executionRoleArn: "arn:aws:iam::123456789012:role/mine",
      }),
    });
    const result = await convertHarness(dir, { name: "h", path: "app/h" });
    expect(result.facts).toEqual({
      dockerfile: "Dockerfile",
      containerUri: undefined,
      executionRoleArn: "arn:aws:iam::123456789012:role/mine",
    });
    expect(result.warnings).toEqual([]);
  });

  test("keeps a file-backed prompt in system-prompt.md, inlining nothing", async () => {
    const dir = await root({
      "app/h/harness.json": JSON.stringify(F1_HARNESS),
      "app/h/system-prompt.md": "From the file.\n",
    });
    const result = await convertHarness(dir, { name: "h", path: "app/h" });
    expect(parse(result.yaml!)).not.toHaveProperty("systemPrompt");
    expect(result.warnings).toEqual([]);
  });

  test("keeps an inline prompt inline and warns that system-prompt.md is ignored", async () => {
    const dir = await root({
      "app/h/harness.json": JSON.stringify({ ...F1_HARNESS, systemPrompt: "Inline." }),
      "app/h/system-prompt.md": "From the file.\n",
    });
    const result = await convertHarness(dir, { name: "h", path: "app/h" });
    expect((parse(result.yaml!) as Record<string, unknown>).systemPrompt).toEqual([
      { text: "Inline." },
    ]);
    expect(result.warnings).toEqual([
      "app/h/system-prompt.md is ignored because harness.json sets systemPrompt inline; v1 does " +
        "the same. Delete the file, or remove systemPrompt from harness.yaml to use it.",
    ]);
  });

  test("reports a missing harness.json", async () => {
    const result = await convertHarness(await root({}), { name: "h", path: "app/h" });
    expect(result.yaml).toBeUndefined();
    expect(result.problems).toEqual([
      {
        file: "app/h/harness.json",
        path: "(file)",
        message: expect.stringContaining("Couldn't read it"),
      },
    ]);
  });
});
