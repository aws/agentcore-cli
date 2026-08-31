import { describe, expect, test } from "bun:test";
import type { Harness } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError, MalformedServiceResponseError } from "../../../errors";
import { harnessIdFromArn, mapServiceHarnessToSpec, regionFromHarnessArn } from "./serviceHarness";

const ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-abc123";

function serviceHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    harnessId: "h-abc123",
    harnessName: "assistant",
    arn: ARN,
    status: "READY",
    executionRoleArn: "arn:aws:iam::111122223333:role/HarnessRole",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    model: {
      bedrockModelConfig: {
        modelId: "us.amazon.nova-lite-v1:0",
        temperature: 0.3,
        maxTokens: 512,
      },
    },
    systemPrompt: [{ text: "Be terse." }],
    tools: [],
    skills: [],
    allowedTools: undefined,
    truncation: undefined,
    environment: undefined,
    ...overrides,
  } as Harness;
}

describe("harness ARN helpers", () => {
  test("extracts the harness id and region from an ARN", () => {
    expect(harnessIdFromArn(ARN)).toBe("h-abc123");
    expect(regionFromHarnessArn(ARN)).toBe("us-west-2");
  });

  test("rejects a malformed harness ARN and tolerates a missing region", () => {
    expect(() => harnessIdFromArn("arn:aws:foo:bar")).toThrow(InputValidationError);
    expect(regionFromHarnessArn("not-an-arn")).toBeUndefined();
  });
});

describe("mapServiceHarnessToSpec", () => {
  test("maps a bedrock harness with prompt, limits, env vars, and containerUri", () => {
    const { spec, systemPrompt } = mapServiceHarnessToSpec(
      serviceHarness({
        systemPrompt: [{ text: "Be terse." }, { text: "Be kind." }],
        maxIterations: 4,
        maxTokens: 1024,
        timeoutSeconds: 30,
        environmentVariables: { LOG_LEVEL: "debug" },
        environmentArtifact: {
          containerConfiguration: {
            containerUri: "111122223333.dkr.ecr.us-west-2.amazonaws.com/base:latest",
          },
        },
        truncation: {
          strategy: "sliding_window",
          config: { slidingWindow: { messagesCount: 12 } },
        },
      } as Partial<Harness>),
    );

    expect(spec.name).toBe("assistant");
    expect(spec.model).toEqual({
      provider: "bedrock",
      modelId: "us.amazon.nova-lite-v1:0",
      temperature: 0.3,
      maxTokens: 512,
    });
    expect(systemPrompt).toBe("Be terse.\nBe kind.");
    expect(spec.maxIterations).toBe(4);
    expect(spec.maxTokens).toBe(1024);
    expect(spec.timeoutSeconds).toBe(30);
    expect(spec.environmentVariables).toEqual({ LOG_LEVEL: "debug" });
    expect(spec.containerUri).toBe("111122223333.dkr.ecr.us-west-2.amazonaws.com/base:latest");
    expect(spec.truncation).toEqual({
      strategy: "sliding_window",
      config: { slidingWindow: { messagesCount: 12 } },
    });
    // The harness role must not follow the export.
    expect(spec.executionRoleArn).toBeUndefined();
  });

  test("maps every skill source variant and drops unknown members", () => {
    const { spec } = mapServiceHarnessToSpec(
      serviceHarness({
        skills: [
          { path: "local_skill" },
          { s3: { uri: "s3://bucket/prefix" } },
          {
            git: {
              url: "https://github.com/example/skills.git",
              path: "subdir",
              auth: {
                credentialArn:
                  "arn:aws:bedrock-agentcore:us-west-2:111122223333:token-vault/default/apikeycredentialprovider/GitPat",
                username: "bot",
              },
            },
          },
          { awsSkills: { paths: ["aws/foo"] } },
          { $unknown: ["mystery", {}] },
        ] as Harness["skills"],
      }),
    );

    expect(spec.skills).toEqual([
      { path: "local_skill" },
      { s3Uri: "s3://bucket/prefix" },
      {
        gitUrl: "https://github.com/example/skills.git",
        path: "subdir",
        auth: {
          credentialArn:
            "arn:aws:bedrock-agentcore:us-west-2:111122223333:token-vault/default/apikeycredentialprovider/GitPat",
          username: "bot",
        },
      },
      { awsSkills: { paths: ["aws/foo"] } },
    ]);
  });

  test("maps tools by passing their config through", () => {
    const { spec } = mapServiceHarnessToSpec(
      serviceHarness({
        tools: [
          {
            type: "remote_mcp",
            name: "exa",
            config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
          },
          { type: "agentcore_code_interpreter" },
        ] as Harness["tools"],
      }),
    );
    expect(spec.tools).toEqual([
      { type: "remote_mcp", name: "exa", config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } } },
      { type: "agentcore_code_interpreter", name: "agentcore_code_interpreter" },
    ]);
  });

  test.each([
    [
      "an existing memory by arn",
      {
        agentCoreMemoryConfiguration: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-1",
          actorId: "actor-1",
        },
      },
      {
        mode: "existing",
        arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-1",
        actorId: "actor-1",
      },
    ],
    [
      "a provisioned managed memory as existing-by-arn",
      {
        managedMemoryConfiguration: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-2",
        },
      },
      { mode: "existing", arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-2" },
    ],
    [
      "an unprovisioned managed memory as managed",
      { managedMemoryConfiguration: {} },
      { mode: "managed" },
    ],
    ["disabled memory as disabled", { disabled: {} }, { mode: "disabled" }],
  ])("maps %s", (_label, memory, expected) => {
    const { spec } = mapServiceHarnessToSpec(serviceHarness({ memory } as Partial<Harness>));
    expect(spec.memory).toEqual(expected as never);
  });

  test("maps the runtime environment: VPC, lifecycle, and filesystem mounts", () => {
    const { spec } = mapServiceHarnessToSpec(
      serviceHarness({
        environment: {
          agentCoreRuntimeEnvironment: {
            networkConfiguration: {
              networkMode: "VPC",
              networkModeConfig: {
                subnets: ["subnet-12345678"],
                securityGroups: ["sg-12345678"],
              },
            },
            lifecycleConfiguration: { idleRuntimeSessionTimeout: 900 },
            filesystemConfigurations: [
              { sessionStorage: { mountPath: "/mnt/session" } },
              {
                efsAccessPoint: {
                  accessPointArn:
                    "arn:aws:elasticfilesystem:us-west-2:111122223333:access-point/fsap-0123456789abcdef0",
                  mountPath: "/mnt/tools",
                },
              },
            ],
          },
        },
      } as Partial<Harness>),
    );

    expect(spec.networkMode).toBe("VPC");
    expect(spec.networkConfig).toEqual({
      subnets: ["subnet-12345678"],
      securityGroups: ["sg-12345678"],
    });
    expect(spec.lifecycleConfig).toEqual({ idleRuntimeSessionTimeout: 900 });
    expect(spec.sessionStoragePath).toBe("/mnt/session");
    expect(spec.efsAccessPoints).toEqual([
      {
        accessPointArn:
          "arn:aws:elasticfilesystem:us-west-2:111122223333:access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/tools",
      },
    ]);
  });

  test("rejects a VPC harness without explicit subnets/security groups before anything is written", () => {
    expect(() =>
      mapServiceHarnessToSpec(
        serviceHarness({
          environment: {
            agentCoreRuntimeEnvironment: {
              networkConfiguration: { networkMode: "VPC" },
            },
          },
        } as Partial<Harness>),
      ),
    ).toThrow(InputValidationError);
  });

  test("maps openai and litellm model configs", () => {
    const openAi = mapServiceHarnessToSpec(
      serviceHarness({
        model: {
          openAiModelConfig: {
            modelId: "gpt-4.1",
            apiKeyArn:
              "arn:aws:bedrock-agentcore:us-west-2:111122223333:token-vault/default/apikeycredentialprovider/K",
            apiFormat: "responses",
          },
        },
      } as Partial<Harness>),
    ).spec;
    expect(openAi.model.provider).toBe("open_ai");
    expect(openAi.model.apiFormat).toBe("responses");

    const liteLlm = mapServiceHarnessToSpec(
      serviceHarness({
        model: {
          liteLlmModelConfig: {
            modelId: "bedrock/us.amazon.nova-lite-v1:0",
            apiBase: "https://litellm.example",
            additionalParams: { max_retries: 2 },
          },
        },
      } as Partial<Harness>),
    ).spec;
    expect(liteLlm.model.provider).toBe("lite_llm");
    expect(liteLlm.model.apiBase).toBe("https://litellm.example");
    expect(liteLlm.model.additionalParams).toEqual({ max_retries: 2 });
  });

  test("wraps an inexpressible payload in a MalformedServiceResponseError", () => {
    expect(() => mapServiceHarnessToSpec(serviceHarness({ model: undefined }))).toThrow(
      MalformedServiceResponseError,
    );
    expect(() =>
      mapServiceHarnessToSpec(serviceHarness({ harnessName: "definitely not a valid name" })),
    ).toThrow(MalformedServiceResponseError);
  });
});
