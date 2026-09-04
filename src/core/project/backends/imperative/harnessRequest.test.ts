import { describe, expect, test } from "bun:test";
import type { Harness, HarnessModelConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { HarnessSpecSchema, type HarnessSpec } from "../../../../projectSchemas/harness";
import { mapServiceHarnessToSpec } from "../../../../handlers/project/export/serviceHarness";
import {
  buildCreateHarnessRequest,
  buildUpdateHarnessRequest,
  harnessRequestHash,
  mapSkill,
  validateForImperativeDeploy,
} from "./harnessRequest";
import { hashOf, stableStringify } from "./hash";

const ROLE = "arn:aws:iam::111122223333:role/AgentCoreHarness-support";

function spec(overrides: Record<string, unknown> = {}): HarnessSpec {
  return HarnessSpecSchema.parse({
    name: "support",
    model: { provider: "bedrock", modelId: "global.anthropic.claude-sonnet-4-6" },
    ...overrides,
  });
}

describe("buildCreateHarnessRequest", () => {
  test("maps the minimal spec, omitting every unset field", () => {
    const request = buildCreateHarnessRequest(spec(), "Be helpful.", ROLE);

    expect(request).toEqual({
      harnessName: "support",
      executionRoleArn: ROLE,
      model: { bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-4-6" } },
      systemPrompt: [{ text: "Be helpful." }],
      tools: [],
      skills: [],
      // Omitted memory is sent as disabled, as the CDK construct does; left out,
      // the service would auto-provision a managed memory.
      memory: { disabled: {} },
    });
    // Nothing undefined-valued survives: the fixtures should stay tidy and some
    // SDKs reject explicit undefineds.
    expect(Object.values(request).some((v) => v === undefined)).toBe(false);
  });

  test.each([
    [
      "bedrock",
      {
        provider: "bedrock",
        modelId: "m",
        apiFormat: "responses",
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 512,
      },
      {
        bedrockModelConfig: {
          modelId: "m",
          apiFormat: "responses",
          temperature: 0.2,
          topP: 0.9,
          maxTokens: 512,
        },
      },
    ],
    [
      "open_ai",
      {
        provider: "open_ai",
        modelId: "gpt-5",
        apiKeyArn: "arn:key",
        apiFormat: "chat_completions",
      },
      {
        openAiModelConfig: {
          modelId: "gpt-5",
          apiKeyArn: "arn:key",
          apiFormat: "chat_completions",
        },
      },
    ],
    [
      "gemini",
      { provider: "gemini", modelId: "gemini-2.5-flash", apiKeyArn: "arn:key", topK: 40 },
      { geminiModelConfig: { modelId: "gemini-2.5-flash", apiKeyArn: "arn:key", topK: 40 } },
    ],
    [
      "lite_llm",
      {
        provider: "lite_llm",
        modelId: "bedrock/m",
        apiBase: "https://llm.example",
        additionalParams: { a: 1 },
      },
      {
        liteLlmModelConfig: {
          modelId: "bedrock/m",
          apiBase: "https://llm.example",
          additionalParams: { a: 1 },
        },
      },
    ],
  ])("maps the %s provider onto its member", (_provider, model, expected) => {
    expect(buildCreateHarnessRequest(spec({ model }), "p", ROLE).model).toEqual(
      expected as HarnessModelConfiguration,
    );
  });

  test("maps every skill shape onto the service union", () => {
    expect(mapSkill({ path: "/skills/local" })).toEqual({ path: "/skills/local" });
    expect(mapSkill({ s3Uri: "s3://b/k/" })).toEqual({ s3: { uri: "s3://b/k/" } });
    expect(
      mapSkill({
        gitUrl: "https://git.example/r.git",
        path: "skills/x",
        auth: { credentialArn: "arn:cred", username: "bot" },
      }),
    ).toEqual({
      git: {
        url: "https://git.example/r.git",
        path: "skills/x",
        auth: { credentialArn: "arn:cred", username: "bot" },
      },
    });
    expect(mapSkill({ gitUrl: "https://git.example/r.git" })).toEqual({
      git: { url: "https://git.example/r.git" },
    });
    expect(mapSkill({ awsSkills: {} })).toEqual({ awsSkills: {} });
    expect(mapSkill({ awsSkills: { paths: ["core-skills/*"] } })).toEqual({
      awsSkills: { paths: ["core-skills/*"] },
    });
  });

  test("appends extra skills after the spec's own, in the order given", () => {
    const request = buildCreateHarnessRequest(
      spec({ skills: [{ s3Uri: "s3://b/from-spec/" }] }),
      "p",
      ROLE,
      [{ s3: { uri: "s3://b/discovered/" } }],
    );
    expect(request.skills).toEqual([
      { s3: { uri: "s3://b/from-spec/" } },
      { s3: { uri: "s3://b/discovered/" } },
    ]);
  });

  test("maps memory modes onto the three union members", () => {
    const of = (memory: unknown) => buildCreateHarnessRequest(spec({ memory }), "p", ROLE).memory;
    expect(of({ mode: "disabled" })).toEqual({ disabled: {} });
    expect(of({ mode: "managed", strategies: ["SEMANTIC"], eventExpiryDuration: 7 })).toEqual({
      managedMemoryConfiguration: { strategies: ["SEMANTIC"], eventExpiryDuration: 7 },
    });
    expect(of({ mode: "existing", arn: "arn:mem", actorId: "u1", messagesCount: 20 })).toEqual({
      agentCoreMemoryConfiguration: { arn: "arn:mem", actorId: "u1", messagesCount: 20 },
    });
    expect(of(undefined)).toEqual({ disabled: {} });
  });

  test("maps the runtime environment, container, authorizer, and scalar fields", () => {
    const request = buildCreateHarnessRequest(
      spec({
        tools: [{ type: "agentcore_browser", name: "browser" }],
        allowedTools: ["*"],
        maxIterations: 10,
        maxTokens: 4000,
        timeoutSeconds: 120,
        truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 5 } } },
        environmentVariables: { A: "1" },
        tags: { team: "x" },
        containerUri: "public.ecr.aws/docker/library/node:22",
        networkMode: "VPC",
        networkConfig: {
          subnets: ["subnet-0123456789abcdef0"],
          securityGroups: ["sg-0123456789abcdef0"],
        },
        lifecycleConfig: { idleRuntimeSessionTimeout: 600, maxLifetime: 3600 },
        sessionStoragePath: "/mnt/session",
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
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: "https://issuer.example/.well-known/openid-configuration",
            allowedAudience: ["aud"],
          },
        },
      }),
      "p",
      ROLE,
    );

    expect(request.tools).toEqual([{ type: "agentcore_browser", name: "browser" }]);
    expect(request.allowedTools).toEqual(["*"]);
    expect(request.maxIterations).toBe(10);
    expect(request.maxTokens).toBe(4000);
    expect(request.timeoutSeconds).toBe(120);
    expect(request.truncation).toEqual({
      strategy: "sliding_window",
      config: { slidingWindow: { messagesCount: 5 } },
    });
    expect(request.environmentVariables).toEqual({ A: "1" });
    expect(request.tags).toEqual({ team: "x" });
    expect(request.environmentArtifact).toEqual({
      containerConfiguration: { containerUri: "public.ecr.aws/docker/library/node:22" },
    });
    expect(request.environment).toEqual({
      agentCoreRuntimeEnvironment: {
        networkConfiguration: {
          networkMode: "VPC",
          networkModeConfig: {
            subnets: ["subnet-0123456789abcdef0"],
            securityGroups: ["sg-0123456789abcdef0"],
          },
        },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: 600, maxLifetime: 3600 },
        filesystemConfigurations: [
          { sessionStorage: { mountPath: "/mnt/session" } },
          {
            efsAccessPoint: {
              accessPointArn:
                "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
              mountPath: "/mnt/efs",
            },
          },
          {
            s3FilesAccessPoint: {
              accessPointArn:
                "arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef01",
              mountPath: "/mnt/s3",
            },
          },
        ],
      },
    });
    expect(request.authorizerConfiguration).toEqual({
      customJWTAuthorizer: {
        discoveryUrl: "https://issuer.example/.well-known/openid-configuration",
        allowedAudience: ["aud"],
      },
    });
  });

  test("a PUBLIC network mode alone still produces an environment", () => {
    const request = buildCreateHarnessRequest(spec({ networkMode: "PUBLIC" }), "p", ROLE);
    expect(request.environment).toEqual({
      agentCoreRuntimeEnvironment: { networkConfiguration: { networkMode: "PUBLIC" } },
    });
  });
});

describe("buildUpdateHarnessRequest", () => {
  test("carries the id, always sends the owned collections, and wraps optional values", () => {
    const request = buildUpdateHarnessRequest("support-abc", spec(), "p", ROLE);

    expect(request).toEqual({
      harnessId: "support-abc",
      executionRoleArn: ROLE,
      model: { bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-4-6" } },
      systemPrompt: [{ text: "p" }],
      tools: [],
      skills: [],
      allowedTools: [],
      environmentVariables: {},
      memory: { optionalValue: { disabled: {} } },
      environmentArtifact: {},
      authorizerConfiguration: {},
    });
    expect("harnessName" in request).toBe(false);
    expect("tags" in request).toBe(false);
  });

  test("wraps a set memory and container in optionalValue", () => {
    const request = buildUpdateHarnessRequest(
      "id",
      spec({ memory: { mode: "disabled" }, containerUri: "public.ecr.aws/x/y:1" }),
      "p",
      ROLE,
    );
    expect(request.memory).toEqual({ optionalValue: { disabled: {} } });
    expect(request.environmentArtifact).toEqual({
      optionalValue: { containerConfiguration: { containerUri: "public.ecr.aws/x/y:1" } },
    });
  });
});

describe("harnessRequestHash", () => {
  test("ignores the client token and key order, and changes with the prompt", () => {
    const a = buildCreateHarnessRequest(spec(), "p", ROLE);
    const b = { clientToken: "t", ...buildCreateHarnessRequest(spec(), "p", ROLE) };
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    const changed = buildCreateHarnessRequest(spec(), "different", ROLE);

    expect(harnessRequestHash(a)).toBe(harnessRequestHash(b));
    expect(harnessRequestHash(a)).toBe(harnessRequestHash(reordered));
    expect(harnessRequestHash(a)).not.toBe(harnessRequestHash(changed));
    expect(harnessRequestHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes with the skills manifest so edited skill files trigger an update", () => {
    const request = buildCreateHarnessRequest(spec(), "p", ROLE);
    expect(harnessRequestHash(request, "m1")).toBe(harnessRequestHash(request, "m1"));
    expect(harnessRequestHash(request, "m1")).not.toBe(harnessRequestHash(request, "m2"));
    expect(harnessRequestHash(request, "m1")).not.toBe(harnessRequestHash(request));
  });

  test("stableStringify sorts nested keys but keeps array order", () => {
    expect(stableStringify({ b: [{ y: 1, x: 2 }, 3], a: undefined, c: 1 })).toBe(
      '{"b":[{"x":2,"y":1},3],"c":1}',
    );
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
});

describe("validateForImperativeDeploy", () => {
  test("accepts a spec with only supported fields", () => {
    expect(() =>
      validateForImperativeDeploy(
        spec({
          skills: [
            { s3Uri: "s3://b/k/" },
            { gitUrl: "https://g.example/r.git" },
            { awsSkills: {} },
          ],
          memory: { mode: "existing", arn: "arn:mem" },
          containerUri: "public.ecr.aws/x/y:1",
        }),
      ),
    ).not.toThrow();
  });

  test("lists every unsupported field in one error", () => {
    let message = "";
    try {
      validateForImperativeDeploy(
        spec({
          dockerfile: "Dockerfile",
          skills: [
            "./local-skill",
            { gitUrl: "https://g.example/r.git", auth: { credentialName: "gh" } },
          ],
          memory: { mode: "existing", name: "recall" },
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "Harness 'support' uses fields the imperative deploy does not support",
    );
    expect(message).toContain("'dockerfile'");
    expect(message).toContain("'skills[0]' (path './local-skill')");
    expect(message).toContain("'skills[1].auth.credentialName'");
    expect(message).toContain("'memory.name' ('recall')");
    expect(message).toContain("AGENTCORE_CLI_EXPERIMENTAL_IMPERATIVE_DEPLOY");
  });
});

// The service -> spec mapper (used by `project export harness --arn`) and this
// spec -> request mapper are inverses. Feeding the request back through the
// export mapper as if the service had returned it must reproduce the spec,
// modulo the fields that mapper documents as dropped.
describe("round trip through mapServiceHarnessToSpec", () => {
  const full = spec({
    model: {
      provider: "open_ai",
      modelId: "gpt-5",
      apiKeyArn: "arn:key",
      apiFormat: "responses",
      temperature: 0.3,
      topP: 0.8,
      maxTokens: 800,
    },
    tools: [
      { type: "agentcore_browser", name: "browser" },
      {
        type: "remote_mcp",
        name: "docs",
        config: { remoteMcp: { url: "https://mcp.example/sse", headers: { A: "b" } } },
      },
    ],
    skills: [
      { s3Uri: "s3://b/k/" },
      { gitUrl: "https://g.example/r.git", path: "skills/x", auth: { credentialArn: "arn:c" } },
      { awsSkills: { paths: ["core/*"] } },
    ],
    allowedTools: ["*"],
    memory: { mode: "existing", arn: "arn:mem", actorId: "u", messagesCount: 5 },
    maxIterations: 7,
    maxTokens: 900,
    timeoutSeconds: 60,
    truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 9 } } },
    environmentVariables: { K: "v" },
    containerUri: "public.ecr.aws/x/y:1",
    networkMode: "VPC",
    networkConfig: {
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    },
    lifecycleConfig: { idleRuntimeSessionTimeout: 600, maxLifetime: 3600 },
    sessionStoragePath: "/mnt/session",
    efsAccessPoints: [
      {
        accessPointArn:
          "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/efs",
      },
    ],
  });

  test("reproduces the spec, minus the fields the export mapper drops", () => {
    const request = buildCreateHarnessRequest(full, "The prompt.", ROLE);
    const harness: Harness = {
      ...request,
      harnessId: "support-abc",
      arn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/support-abc",
      status: "READY",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      // The service reports the environment with the runtime it provisioned.
      environment: {
        agentCoreRuntimeEnvironment: {
          ...request.environment!.agentCoreRuntimeEnvironment!,
          agentRuntimeArn: "arn:rt",
          agentRuntimeName: "harness_support",
          agentRuntimeId: "rt-1",
        },
      } as Harness["environment"],
      allowedTools: request.allowedTools,
      truncation: request.truncation,
      tools: request.tools,
      skills: request.skills,
      systemPrompt: request.systemPrompt,
    } as Harness;

    const mapped = mapServiceHarnessToSpec(harness);

    // executionRoleArn is deliberately not carried by the export mapper (the
    // exported agent gets its own role); tags and the authorizer are not part of
    // the Harness payload it reads.
    const { executionRoleArn: _role, ...expected } = full;
    expect(mapped.spec).toEqual(expected as HarnessSpec);
    expect(mapped.systemPrompt).toBe("The prompt.");
    // The only note is the export mapper's own follow-up about memory tuning;
    // nothing was dropped as unknown or incomplete.
    expect(mapped.notes.map((note) => note.category)).toEqual([
      "Harness memory tuning requires manual follow-up",
    ]);
  });
});
