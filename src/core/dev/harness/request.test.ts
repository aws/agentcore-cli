import { describe, expect, test } from "bun:test";
import type { Harness } from "@aws-sdk/client-bedrock-agentcore-control";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";
import type { HarnessFiles } from "../../project/fsUtils";
import {
  assertLocalSupported,
  omittedReferences,
  toContainerRequest,
  type HarnessInvokeRequest,
} from "./request";

function harnessFiles(spec: Record<string, unknown> = {}, systemPrompt?: string): HarnessFiles {
  return {
    spec: HarnessSpecSchema.parse({
      name: "h1",
      model: { provider: "bedrock", modelId: "m1" },
      ...spec,
    }),
    ...(systemPrompt && { systemPrompt }),
  };
}

function container(files: HarnessFiles, request: Partial<HarnessInvokeRequest> = {}) {
  const { body, apiKey } = toContainerRequest(files, undefined, { prompt: "hi", ...request });
  return { payload: body.invokePayload as Record<string, unknown>, apiKey };
}

const VPC = {
  networkMode: "VPC",
  networkConfig: { subnets: ["subnet-12345678"], securityGroups: ["sg-12345678"] },
};

describe("toContainerRequest", () => {
  test.each([
    [
      "bedrock",
      { modelId: "m", temperature: 0.2 },
      { bedrockModelConfig: { modelId: "m", temperature: 0.2 } },
      false,
    ],
    [
      "open_ai",
      { modelId: "m", apiKeyArn: "k", apiFormat: "responses" },
      { openAiModelConfig: { modelId: "m", apiKeyArn: "k", apiFormat: "responses" } },
      true,
    ],
    [
      "gemini",
      { modelId: "m", apiKeyArn: "k", topK: 5 },
      { geminiModelConfig: { modelId: "m", apiKeyArn: "k", topK: 5 } },
      true,
    ],
    [
      "lite_llm",
      { modelId: "m", apiBase: "https://x", additionalParams: { a: 1 } },
      { liteLlmModelConfig: { modelId: "m", apiBase: "https://x", additionalParams: { a: 1 } } },
      false,
    ],
  ])("maps the %s model", (provider, fields, expected, apiKey) => {
    const request = container(harnessFiles({ model: { provider, ...fields } }));

    expect(request.payload.model).toEqual(expected);
    expect(request.apiKey).toBe(apiKey);
  });

  test("overrides win field by field", () => {
    const files = harnessFiles({ maxIterations: 3, allowedTools: ["a"] }, "spec prompt");

    const { payload, apiKey } = container(files, {
      harnessOverrides: {
        model: { openAiModelConfig: { modelId: "override", apiKeyArn: "k" } },
        systemPrompt: "override prompt",
        maxIterations: 9,
      },
    });

    expect(apiKey).toBe(true);
    expect(payload).toMatchObject({
      model: { openAiModelConfig: { modelId: "override", apiKeyArn: "k" } },
      systemPrompt: [{ text: "override prompt" }],
      maxIterations: 9,
      allowedTools: ["a"],
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });
  });

  test("maps skills to the wire shape and passes tools through", () => {
    const tools = [
      {
        type: "agentcore_gateway",
        name: "gw",
        config: { agentCoreGateway: { gatewayArn: "arn:gw" } },
      },
    ];
    const { payload } = container(
      harnessFiles({
        skills: [
          "./skills/a",
          { s3Uri: "s3://b/c" },
          { gitUrl: "https://g/r", path: "p", auth: { credentialArn: "arn:c" } },
          { awsSkills: {} },
        ],
        tools,
      }),
    );

    expect(payload.skills).toEqual([
      { path: "./skills/a" },
      { s3: { uri: "s3://b/c" } },
      { git: { url: "https://g/r", path: "p", auth: { credentialArn: "arn:c" } } },
      { awsSkills: {} },
    ]);
    expect(payload.tools).toEqual(tools);
  });

  const REFERENCED = harnessFiles({
    memory: { mode: "managed" },
    skills: [{ gitUrl: "https://g/r", auth: { credentialName: "gitcred" } }],
  });
  const DEPLOYED = {
    arn: "arn:harness",
    memory: { managedMemoryConfiguration: { arn: "arn:memory" } },
    skills: [{ git: { url: "https://g/r", auth: { credentialArn: "arn:deployed-cred" } } }],
  } as Harness;

  test.each([
    [
      "deployed, so references come from GetHarness",
      DEPLOYED,
      {
        harnessArn: "arn:harness",
        memoryConfig: { agentCoreMemoryConfiguration: { arn: "arn:memory" } },
        skills: [{ git: { url: "https://g/r", auth: { credentialArn: "arn:deployed-cred" } } }],
      },
      [],
    ],
    [
      "not deployed, so references are omitted",
      undefined,
      { harnessArn: undefined, memoryConfig: undefined, skills: [] },
      ["memory", "git skill https://g/r"],
    ],
  ])("the target is %s", (_case, deployed, expected, omitted) => {
    const { body } = toContainerRequest(REFERENCED, deployed, { prompt: "hi" });

    expect({
      harnessArn: body.harnessArn,
      memoryConfig: body.memoryConfig,
      skills: (body.invokePayload as { skills: unknown }).skills,
    }).toEqual(expected);
    expect(omittedReferences(REFERENCED, deployed)).toEqual(omitted);
  });
});

describe("assertLocalSupported", () => {
  test.each([
    ["environmentArtifact", { containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/r:t" }],
    ["dockerfile", { dockerfile: "Dockerfile" }],
    [
      "environment.agentCoreRuntimeEnvironment.filesystemConfigurations efsAccessPoint",
      {
        ...VPC,
        efsAccessPoints: [
          {
            accessPointArn:
              "arn:aws:elasticfilesystem:us-west-2:123456789012:access-point/fsap-12345678",
            mountPath: "/mnt/efs",
          },
        ],
      },
    ],
    [
      "environment.agentCoreRuntimeEnvironment.filesystemConfigurations s3FilesAccessPoint",
      {
        ...VPC,
        s3AccessPoints: [
          {
            accessPointArn:
              "arn:aws:s3files:us-west-2:123456789012:file-system/fs-0123456789abcdef0/access-point/fsap-0123456789abcdef0",
            mountPath: "/mnt/s3",
          },
        ],
      },
    ],
  ])("rejects %s by its YAML name", (field, spec) => {
    expect(() => assertLocalSupported("h1", harnessFiles(spec).spec)).toThrow(
      `Harness 'h1' sets '${field}', which local dev does not support`,
    );
  });

  test("accepts empty access point lists", () => {
    const { spec } = harnessFiles({ efsAccessPoints: [], s3AccessPoints: [] });

    expect(() => assertLocalSupported("h1", spec)).not.toThrow();
  });
});
