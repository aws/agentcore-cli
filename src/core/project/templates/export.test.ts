import { describe, expect, test } from "bun:test";
import z from "zod";
import { InputValidationError } from "../../../errors/errors";
import { HarnessSpecSchema, type HarnessSpec } from "../../../projectSchemas/harness";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import {
  ALLOWED_TOOLS_NOTE_CATEGORY,
  AWS_SKILLS_NOTE_CATEGORY,
  BROWSER_TOOL_NOTE_CATEGORY,
  CODE_INTERPRETER_TOOL_NOTE_CATEGORY,
  CONTAINER_IMAGE_NOTE_CATEGORY,
  GATEWAY_TOOL_NOTE_CATEGORY,
  GIT_SKILLS_AUTH_NOTE_CATEGORY,
  LITELLM_NO_API_KEY_NOTE_CATEGORY,
  MALFORMED_S3_SKILL_NOTE_CATEGORY,
  MCP_HEADER_CREDS_NOTE_CATEGORY,
  MEMORY_ARN_NOTE_CATEGORY,
  MEMORY_MANAGED_NOTE_CATEGORY,
  MEMORY_MESSAGES_COUNT_NOTE_CATEGORY,
  MEMORY_NAME_NOT_FOUND_NOTE_CATEGORY,
  MODEL_API_KEY_NOTE_CATEGORY,
  buildExportNotesMarkdown,
  formatExportNotes,
  mapHarnessToExportPlan,
  matchesAllowedTools,
  type HarnessExportInput,
} from "./export";

function harness(spec: Record<string, unknown>): HarnessSpec {
  return HarnessSpecSchema.parse({
    name: "assistant",
    model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
    ...spec,
  });
}

function projectSpec(overrides: Record<string, unknown> = {}) {
  return ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    managedBy: "CDK",
    ...overrides,
  });
}

function plan(overrides: Partial<HarnessExportInput> & { spec?: HarnessSpec } = {}) {
  return mapHarnessToExportPlan({
    harnessName: "assistant",
    targetAgentName: "assistantAgent",
    spec: harness({}),
    systemPrompt: "You are a terse assistant.",
    projectSpec: projectSpec(),
    ...overrides,
  });
}

function categories(result: ReturnType<typeof mapHarnessToExportPlan>): string[] {
  return result.notes.map((note) => note.category);
}

describe("mapHarnessToExportPlan model mapping", () => {
  test("maps a bedrock model with sampling params and limits into the render context", () => {
    const result = plan({
      spec: harness({
        model: {
          provider: "bedrock",
          modelId: "us.amazon.nova-lite-v1:0",
          temperature: 0.2,
          topP: 0.9,
          maxTokens: 512,
        },
        maxIterations: 5,
        maxTokens: 2048,
        timeoutSeconds: 60,
      }),
    });

    expect(result.context.modelProvider).toBe("Bedrock");
    expect(result.context.modelId).toBe("us.amazon.nova-lite-v1:0");
    expect(result.context.modelTemperature).toBe("0.2");
    expect(result.context.modelTopP).toBe("0.9");
    expect(result.context.modelMaxTokens).toBe("512");
    expect(result.context.bedrockMantle).toBeUndefined();
    expect(result.context.hasExecutionLimits).toBe(true);
    expect(result.context.maxIterations).toBe(5);
    expect(result.context.maxTokens).toBe(2048);
    expect(result.context.timeoutSeconds).toBe(60);
    expect(result.context.systemPromptText).toBe("You are a terse assistant.");
    expect(result.notes).toEqual([]);
  });

  test("keeps a legal temperature of 0 truthy for the template", () => {
    const result = plan({
      spec: harness({
        model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", temperature: 0 },
      }),
    });
    expect(result.context.modelTemperature).toBe("0");
  });

  test("routes an OpenAI-compatible bedrock model through the Mantle branch with its IAM policy", () => {
    const result = plan({
      spec: harness({
        model: { provider: "bedrock", modelId: "openai.gpt-oss-120b", apiFormat: "responses" },
      }),
    });

    expect(result.context.bedrockMantle).toBe(true);
    expect(result.context.mantleApiFormat).toBe("responses");
    expect(result.context.mantleProprietary).toBe(false);
    expect(Object.keys(result.policyFiles)).toEqual(["bedrock-mantle-policy.json"]);
    expect(result.runtime.additionalPolicies).toEqual(["bedrock-mantle-policy.json"]);
  });

  test("wires an open_ai model through an AgentCore Identity credential", () => {
    const result = plan({
      spec: harness({
        model: {
          provider: "open_ai",
          modelId: "gpt-4.1",
          apiFormat: "responses",
          maxTokens: 768,
          temperature: 0.2,
          topP: 0.8,
          apiKeyArn:
            "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/MyOpenAiKey",
        },
      }),
    });

    expect(result.context.modelProvider).toBe("OpenAI");
    expect(result.context.strandsExtras).toBe("openai");
    expect(result.context.modelApiFormat).toBe("responses");
    expect(result.context.modelMaxTokens).toBe("768");
    expect(result.context.modelTemperature).toBe("0.2");
    expect(result.context.modelTopP).toBe("0.8");
    expect(result.context.hasIdentity).toBe(true);
    expect(result.context.identityProviders).toEqual([
      { name: "MyOpenAiKey", envVarName: "AGENTCORE_CREDENTIAL_MYOPENAIKEY" },
    ]);
    expect(result.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "MyOpenAiKey" },
    ]);
    expect(categories(result)).toEqual([MODEL_API_KEY_NOTE_CATEGORY]);
  });

  test("does not duplicate a credential the project already declares", () => {
    const result = plan({
      spec: harness({
        model: {
          provider: "gemini",
          modelId: "gemini-2.5-flash",
          apiKeyArn:
            "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/GemKey",
        },
      }),
      projectSpec: projectSpec({
        credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "GemKey" }],
      }),
    });

    expect(result.context.modelProvider).toBe("Gemini");
    expect(result.context.strandsExtras).toBe("gemini");
    expect(result.credentials).toEqual([]);
  });

  test("threads LiteLLM apiBase and additionalParams and trusts bedrock/ models without a key", () => {
    const result = plan({
      spec: harness({
        model: {
          provider: "lite_llm",
          modelId: "bedrock/us.amazon.nova-lite-v1:0",
          apiBase: "https://litellm.example",
          maxTokens: 300,
          temperature: 0.1,
          topP: 0.7,
          additionalParams: { max_retries: 2 },
        },
      }),
    });

    expect(result.context.modelProvider).toBe("LiteLLM");
    expect(result.context.strandsExtras).toBe("litellm");
    expect(result.context.litellmApiBase).toBe("https://litellm.example");
    expect(result.context.litellmAdditionalParams).toEqual({ max_retries: 2 });
    expect(result.context.modelMaxTokens).toBe("300");
    expect(result.context.modelTemperature).toBe("0.1");
    expect(result.context.modelTopP).toBe("0.7");
    expect(result.notes).toEqual([]);
  });

  test("warns when a keyless LiteLLM model is not Bedrock-backed", () => {
    const result = plan({
      spec: harness({ model: { provider: "lite_llm", modelId: "openai/gpt-4.1" } }),
    });
    expect(categories(result)).toEqual([LITELLM_NO_API_KEY_NOTE_CATEGORY]);
  });
});

describe("mapHarnessToExportPlan tools", () => {
  test("maps remote MCP and inline function tools into the render context", () => {
    const result = plan({
      spec: harness({
        tools: [
          {
            type: "remote_mcp",
            name: "exa",
            config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
          },
          {
            type: "inline_function",
            name: "get_weather",
            config: {
              inlineFunction: {
                description: "Get the weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          },
        ],
      }),
    });

    expect(result.context.remoteMcpTools).toEqual([
      {
        name: "exa",
        pythonName: expect.stringMatching(/^exa_[a-f0-9]{10}$/),
        url: "https://mcp.exa.ai/mcp",
        headerCredentials: undefined,
      },
    ]);
    expect(result.context.inlineFunctionTools).toEqual([
      {
        name: "get_weather",
        description: "Get the weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  test("turns remote MCP headers into identity credentials plus .env.local material", () => {
    const result = plan({
      spec: harness({
        tools: [
          {
            type: "remote_mcp",
            name: "internal",
            config: {
              remoteMcp: {
                url: "https://mcp.internal.example",
                headers: { "X-Api-Key": "s3cret" },
              },
            },
          },
        ],
      }),
    });

    const tools = result.context.remoteMcpTools as {
      headerCredentials?: {
        headerKey: string;
        credentialName: string;
        envVarName: string;
        pythonName: string;
      }[];
    }[];
    const header = tools[0]!.headerCredentials![0]!;
    expect(header.headerKey).toBe("X-Api-Key");
    expect(header.credentialName).toMatch(/^ordersMcpinternalX-Api-Key-[a-f0-9]{10}$/);
    expect(header.envVarName).toBe(credentialEnvVarName(header.credentialName));
    expect(header.pythonName).toMatch(/^internal_x_api_key_[a-f0-9]{10}$/);
    expect(result.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: header.credentialName },
    ]);
    expect(result.envEntries).toEqual([
      {
        key: header.envVarName,
        value: "s3cret",
        comment: '"X-Api-Key" header for MCP tool "internal" (exported from harness "assistant")',
      },
    ]);
    expect(categories(result)).toEqual([MCP_HEADER_CREDS_NOTE_CATEGORY]);
    expect(result.notes[0]!.message).toContain("exists in AgentCore Identity");
  });

  test("keeps normalized header names distinct", () => {
    const result = plan({
      spec: harness({
        tools: [
          {
            type: "remote_mcp",
            name: "internal",
            config: {
              remoteMcp: {
                url: "https://mcp.internal.example",
                headers: { "X-Api-Key": "first", X_Api_Key: "second" },
              },
            },
          },
        ],
      }),
    });

    const names = result.credentials.map((credential) => credential.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(new Set(result.envEntries.map((entry) => entry.key)).size).toBe(2);
    const tools = result.context.remoteMcpTools as {
      headerCredentials: { pythonName: string }[];
    }[];
    expect(new Set(tools[0]!.headerCredentials.map(({ pythonName }) => pythonName)).size).toBe(2);
  });

  test("emits a follow-up note for each unmappable tool type instead of code", () => {
    const result = plan({
      spec: harness({
        tools: [
          {
            type: "agentcore_gateway",
            name: "gw",
            config: {
              agentCoreGateway: {
                gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:gateway/g-1",
              },
            },
          },
          { type: "agentcore_browser", name: "browser" },
          { type: "agentcore_code_interpreter", name: "ci" },
        ],
      }),
    });

    // The render context carries nothing for these tools at all, so the template has no
    // branch to render them from — the notes below are the whole output.
    expect(result.context.hasBrowser).toBeUndefined();
    expect(result.context.hasCodeInterpreter).toBeUndefined();
    expect(result.context.hasGateway).toBeUndefined();
    expect(result.context.remoteMcpTools).toBeUndefined();
    expect(categories(result)).toEqual([
      GATEWAY_TOOL_NOTE_CATEGORY,
      BROWSER_TOOL_NOTE_CATEGORY,
      CODE_INTERPRETER_TOOL_NOTE_CATEGORY,
    ]);
    expect(result.notes[0]!.message).toContain("gateway/g-1");
  });

  test("includes the harness builtins unless allowedTools filters them out", () => {
    const unrestricted = plan({});
    expect(unrestricted.context.hasShell).toBe(true);
    expect(unrestricted.context.hasFileOperations).toBe(true);

    const restricted = plan({
      spec: harness({
        allowedTools: ["@builtin/shell", "exa"],
        tools: [
          {
            type: "remote_mcp",
            name: "exa",
            config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
          },
          {
            type: "remote_mcp",
            name: "other",
            config: { remoteMcp: { url: "https://other.example" } },
          },
        ],
      }),
    });
    expect(restricted.context.hasShell).toBe(true);
    expect(restricted.context.hasFileOperations).toBe(false);
    expect(restricted.context.remoteMcpTools).toEqual([
      {
        name: "exa",
        pythonName: expect.stringMatching(/^exa_[a-f0-9]{10}$/),
        url: "https://mcp.exa.ai/mcp",
        headerCredentials: undefined,
      },
    ]);
    expect(categories(restricted)).toEqual([ALLOWED_TOOLS_NOTE_CATEGORY]);
  });
});

describe("matchesAllowedTools", () => {
  test.each([
    ["*", "anything", true],
    ["exa", "exa", true],
    ["e*", "exa", true],
    ["@builtin/shell", "builtin/shell", true],
    ["@builtin", "builtin/shell", true],
    ["@server/tool", "server_tool", true],
    ["exa", "other", false],
    ["@builtin/shell", "builtin/file_operations", false],
  ])("pattern %s vs %s -> %p", (pattern, name, expected) => {
    expect(matchesAllowedTools(name, [pattern])).toBe(expected);
  });
});

describe("mapHarnessToExportPlan memory", () => {
  test("wires an in-project memory by name with its strategies", () => {
    const result = plan({
      spec: harness({ memory: { mode: "existing", name: "chat_history", actorId: "actor-1" } }),
      projectSpec: projectSpec({
        memories: [
          { name: "chat_history", eventExpiryDuration: 30, strategies: [{ type: "SEMANTIC" }] },
        ],
      }),
    });

    expect(result.hasMemory).toBe(true);
    expect(result.context.memoryEnvVarName).toBe("AGENTCORE_MEMORY_CHAT_HISTORY_ID");
    expect(result.context.memoryStrategies).toEqual(["SEMANTIC"]);
    expect(result.context.actorId).toBe("actor-1");
    expect(result.notes).toEqual([]);
  });

  test("preserves retrieval tuning and notes an unmappable messagesCount", () => {
    const result = plan({
      spec: harness({
        memory: {
          mode: "existing",
          name: "chat_history",
          messagesCount: 12,
          retrievalConfig: { topK: 7, relevanceScore: 0 },
        },
      }),
      projectSpec: projectSpec({
        memories: [
          { name: "chat_history", eventExpiryDuration: 30, strategies: [{ type: "SEMANTIC" }] },
        ],
      }),
    });

    expect(result.context.memoryRetrievalTopK).toBe("7");
    expect(result.context.memoryRetrievalRelevanceScore).toBe("0");
    expect(categories(result)).toEqual([MEMORY_MESSAGES_COUNT_NOTE_CATEGORY]);
  });

  test("notes a by-name memory that is not in the project", () => {
    const result = plan({
      spec: harness({ memory: { mode: "existing", name: "missing" } }),
    });
    expect(result.hasMemory).toBe(false);
    expect(categories(result)).toEqual([MEMORY_NAME_NOT_FOUND_NOTE_CATEGORY]);
  });

  test("notes an external memory referenced by ARN", () => {
    const result = plan({
      spec: harness({
        memory: {
          mode: "existing",
          arn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:memory/m-1",
        },
      }),
    });
    expect(result.hasMemory).toBe(false);
    expect(categories(result)).toEqual([MEMORY_ARN_NOTE_CATEGORY]);
    expect(result.notes[0]!.message).toContain("memory/m-1");
  });

  test("notes managed harness memory and disables none", () => {
    expect(categories(plan({ spec: harness({ memory: { mode: "managed" } }) }))).toEqual([
      MEMORY_MANAGED_NOTE_CATEGORY,
    ]);
    const disabled = plan({ spec: harness({ memory: { mode: "disabled" } }) });
    expect(disabled.hasMemory).toBe(false);
    expect(disabled.notes).toEqual([]);
  });
});

describe("mapHarnessToExportPlan skills", () => {
  test("maps s3 and git skills and generates the S3 read policy", () => {
    const result = plan({
      spec: harness({
        build: undefined,
        skills: [
          { s3Uri: "s3://skills-bucket/team/" },
          { gitUrl: "https://github.com/example/skills.git", path: "subdir" },
        ],
      }),
    });

    expect(result.context.hasSkillsFetcher).toBe(true);
    expect(result.context.hasFetchedSkills).toBe(true);
    expect(result.context.s3Skills).toEqual(["s3://skills-bucket/team/"]);
    expect(result.context.gitSkills).toEqual([
      { url: "https://github.com/example/skills.git", path: "subdir" },
    ]);
    expect(result.policyFiles["s3-skills-policy.json"]).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "s3:GetObject",
          Resource: ["arn:aws:s3:::skills-bucket/team/*"],
        },
        { Effect: "Allow", Action: "s3:ListBucket", Resource: ["arn:aws:s3:::skills-bucket"] },
      ],
    });
    expect(result.runtime.additionalPolicies).toEqual(["s3-skills-policy.json"]);
    expect(result.notes).toEqual([]);
  });

  test("notes a malformed s3 URI instead of generating IAM for it", () => {
    const result = plan({ spec: harness({ skills: [{ s3Uri: "s3://" }] }) });
    expect(categories(result)).toEqual([MALFORMED_S3_SKILL_NOTE_CATEGORY]);
    expect(result.policyFiles).toEqual({});
  });

  test("references the git skill credential provider and notes aws skills", () => {
    const result = plan({
      spec: harness({
        skills: [
          {
            gitUrl: "https://github.com/example/private.git",
            auth: {
              credentialArn:
                "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/GitPat",
            },
          },
          { awsSkills: { paths: ["aws/foo"] } },
        ],
      }),
    });

    expect(result.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "GitPat" },
    ]);
    expect((result.context.gitSkills as unknown[])[0]).toMatchObject({
      url: "https://github.com/example/private.git",
      credentialArn:
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/GitPat",
    });
    expect(categories(result)).toEqual([GIT_SKILLS_AUTH_NOTE_CATEGORY, AWS_SKILLS_NOTE_CATEGORY]);
  });
});

describe("mapHarnessToExportPlan truncation", () => {
  test("maps sliding window config to the Strands conversation manager kwargs", () => {
    const result = plan({
      spec: harness({
        truncation: {
          strategy: "sliding_window",
          config: { slidingWindow: { messagesCount: 20 } },
        },
      }),
    });
    expect(result.context.truncationStrategy).toBe("sliding_window");
    expect(result.context.truncationConfig).toEqual({ window_size: 20 });
  });

  test("maps summarization config keys to snake_case", () => {
    const result = plan({
      spec: harness({
        truncation: {
          strategy: "summarization",
          config: { summarization: { summaryRatio: 0.4, preserveRecentMessages: 6 } },
        },
      }),
    });
    expect(result.context.truncationConfig).toEqual({
      summary_ratio: 0.4,
      preserve_recent_messages: 6,
    });
  });

  test('treats strategy "none" as no conversation manager override', () => {
    const result = plan({ spec: harness({ truncation: { strategy: "none" } }) });
    expect(result.context.truncationStrategy).toBeUndefined();
  });
});

describe("mapHarnessToExportPlan always exports a CodeZip runtime", () => {
  const CONTAINER_URI = "111122223333.dkr.ecr.us-east-1.amazonaws.com/base-image:latest";

  test("emits CodeZip with the PYTHON_3_14 runtime and no Dockerfile", () => {
    const result = plan({});
    expect(result.runtime.build).toBe("CodeZip");
    expect(result.runtime.runtimeVersion).toBe("PYTHON_3_14");
    expect(result.runtime.dockerfile).toBeUndefined();
  });

  test("a containerUri harness still exports as CodeZip, with a note that the image was dropped", () => {
    const result = plan({ spec: harness({ containerUri: CONTAINER_URI }) });
    expect(result.runtime.build).toBe("CodeZip");
    expect(result.runtime.dockerfile).toBeUndefined();
    expect(categories(result)).toEqual([CONTAINER_IMAGE_NOTE_CATEGORY]);
    expect(result.notes[0]?.message).toContain(CONTAINER_URI);
  });

  test("a custom-Dockerfile harness also exports as CodeZip with the same note", () => {
    const result = plan({ spec: harness({ dockerfile: "Dockerfile" }) });
    expect(result.runtime.build).toBe("CodeZip");
    expect(result.runtime.dockerfile).toBeUndefined();
    expect(categories(result)).toEqual([CONTAINER_IMAGE_NOTE_CATEGORY]);
  });

  test("a VPC harness keeps its subnets and security groups and needs no vpcId", () => {
    const result = plan({
      spec: harness({
        containerUri: CONTAINER_URI,
        networkMode: "VPC",
        networkConfig: { subnets: ["subnet-12345678"], securityGroups: ["sg-12345678"] },
      }),
    });
    expect(result.runtime.build).toBe("CodeZip");
    expect(result.runtime.networkConfig).toEqual({
      subnets: ["subnet-12345678"],
      securityGroups: ["sg-12345678"],
    });
  });

  test("rejects path-based skills, which have no container filesystem to read from", () => {
    expect(() => plan({ spec: harness({ skills: [{ path: "/opt/skills/research" }] }) })).toThrow(
      InputValidationError,
    );
  });
});

describe("mapHarnessToExportPlan runtime spec entry", () => {
  test("produces a deployable runtimes[] entry and keeps infra fields", () => {
    const result = plan({
      spec: harness({
        environmentVariables: { LOG_LEVEL: "debug" },
        lifecycleConfig: { idleRuntimeSessionTimeout: 900 },
        networkMode: "VPC",
        networkConfig: { subnets: ["subnet-12345678"], securityGroups: ["sg-12345678"] },
        sessionStoragePath: "/mnt/session",
        efsAccessPoints: [
          {
            accessPointArn:
              "arn:aws:elasticfilesystem:us-east-1:111122223333:access-point/fsap-0123456789abcdef0",
            mountPath: "/mnt/tools",
          },
        ],
        tags: { team: "search" },
        executionRoleArn: "arn:aws:iam::111122223333:role/HarnessRole",
      }),
    });

    expect(result.runtime).toEqual({
      name: "assistantAgent",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/assistantAgent" as (typeof result.runtime)["codeLocation"],
      protocol: "HTTP",
      runtimeVersion: "PYTHON_3_14",
      envVars: [{ name: "LOG_LEVEL", value: "debug" }],
      networkMode: "VPC",
      networkConfig: { subnets: ["subnet-12345678"], securityGroups: ["sg-12345678"] },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 900 },
      filesystemConfigurations: [
        { sessionStorage: { mountPath: "/mnt/session" } },
        {
          efsAccessPoint: {
            accessPointArn:
              "arn:aws:elasticfilesystem:us-east-1:111122223333:access-point/fsap-0123456789abcdef0",
            mountPath: "/mnt/tools",
          },
        },
      ],
      tags: { team: "search" },
    });
    // The harness role must never leak onto the new runtime.
    expect(result.runtime.executionRoleArn).toBeUndefined();
  });

  test("the produced entry validates inside a project spec", () => {
    const result = plan({});
    const spec = projectSpec();
    spec.runtimes.push(result.runtime);
    expect(() => ProjectSpecSchema.parse(spec)).not.toThrow(z.ZodError);
  });
});

describe("export notes rendering", () => {
  test("keeps notes collected while mapping a service harness", () => {
    const sourceNote = { category: "Service field", message: "Review it." };
    const result = plan({ sourceNotes: [sourceNote] });
    expect(result.notes).toContainEqual(sourceNote);
  });

  test("buildExportNotesMarkdown lists each note under its category", () => {
    const markdown = buildExportNotesMarkdown(
      [{ category: "A category", message: "Do the thing." }],
      "assistant",
      "assistantAgent",
      "strands-agents ~= 1.54.0",
    );
    expect(markdown).toContain("# Export Notes — assistant → assistantAgent");
    expect(markdown).toContain("Strands version: strands-agents ~= 1.54.0");
    expect(markdown).toContain("## Items requiring manual follow-up");
    expect(markdown).toContain("### A category");
    expect(markdown).toContain("Do the thing.");
  });

  test("buildExportNotesMarkdown says when nothing is left to do", () => {
    const markdown = buildExportNotesMarkdown([], "assistant", "assistantAgent", "v");
    expect(markdown).toContain("No manual steps required.");
  });

  test("formatExportNotes renders a warning block or a quiet confirmation", () => {
    expect(formatExportNotes([], "notes.md")).toEqual([
      { text: "No manual follow-up required. (Details: notes.md)", tone: "dim" },
    ]);
    const lines = formatExportNotes(
      [{ category: "Cat", message: "line one\nline two" }],
      "notes.md",
    );
    expect(lines.map((line) => line.text)).toEqual([
      "1 export note requiring manual follow-up:",
      "  - Cat",
      "    line one",
      "    line two",
      "These notes are also saved to notes.md",
    ]);
  });
});
