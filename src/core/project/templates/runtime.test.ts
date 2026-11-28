import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { initProject, TestCoreClient } from "../../../testing";
import { toAddRuntimeInput, type RuntimeInput } from "../../../handlers/project/add/runtime";
import {
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../handlers/project/shortcuts";
import { prepareRuntimes } from "../runtimeBuild";
import { importScaffoldRuntimeInput } from "../../../handlers/project/importBedrockAgent";
import type { ModelProvider } from "../../../handlers/project/types";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { readEnvFile } from "../../../io/envFile";

// Runtime templates are scaffolded by `agentcore create --template` (and its
// wizard, which adds model overrides) and by `add runtime --agent-id` (a Bedrock Agent import). These
// tests drive the shared addResource path directly with each template.

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function addTemplate(
  name: string,
  template: RuntimeTemplateShortcutName,
  options: {
    model?: { modelProvider?: ModelProvider; modelId?: string; apiKey?: string; apiBase?: string };
    infra?: Partial<RuntimeInput>;
  } = {},
) {
  const { projectRoot, cleanup } = await initProject();
  cleanups.push(cleanup);
  const core = new TestCoreClient();
  const project = (await core.projectManager.resolve({ filePath: projectRoot }))!;
  const generator = core.projectManager.addResource(
    project,
    toAddRuntimeInput({
      name,
      envVars: [],
      ...options.infra,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(template, {
        runtimeName: name,
        ...options.model,
      }),
    } as RuntimeInput),
  );
  for (let step = await generator.next(); !step.done; step = await generator.next());
  const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
  const runtime = spec.runtimes.find((candidate: { name: string }) => candidate.name === name);
  return { projectRoot, core, spec, runtime, appDir: join(projectRoot, "app", name) };
}

const mounts = {
  networkMode: "VPC",
  networkConfig: {
    subnets: ["subnet-0123456789abcdef0"],
    securityGroups: ["sg-0123456789abcdef0"],
  },
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
          "arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef01/access-point/fsap-0123456789abcdef1",
        mountPath: "/mnt/s3",
      },
    },
  ],
} as const;

describe("runtime templates", () => {
  test.each<[RuntimeTemplateShortcutName, Record<string, unknown>, Partial<RuntimeInput>]>([
    ["agent-python-minimal", { build: "CodeZip", runtimeVersion: "PYTHON_3_14" }, {}],
    ["agent-python-strands", { build: "CodeZip", protocol: "HTTP" }, {}],
    ["agent-python-strands-container", { build: "Container", dockerfile: "Dockerfile" }, {}],
    ["mcp-python-fastmcp", { build: "CodeZip", protocol: "MCP" }, {}],
    ["a2a-python-strands", { build: "CodeZip", protocol: "A2A" }, {}],
    ["agui-python-strands", { build: "CodeZip", protocol: "AGUI" }, {}],
    ["agent-python-strands", { networkMode: "VPC" }, mounts as Partial<RuntimeInput>],
    ["mcp-python-fastmcp", { protocol: "MCP" }, mounts as Partial<RuntimeInput>],
    ["a2a-python-strands", { protocol: "A2A" }, mounts as Partial<RuntimeInput>],
  ])("%s scaffolds code and its spec entry", async (template, expected, infra) => {
    const { runtime, appDir } = await addTemplate("my_agent", template, { infra });
    expect(runtime).toMatchObject({ entrypoint: "main.py", ...expected });
    expect(await Bun.file(join(appDir, "main.py")).exists()).toBe(true);
    const isContainer = template.endsWith("-container");
    expect(runtime.runtimeVersion).toBe(isContainer ? undefined : "PYTHON_3_14");
    expect(await Bun.file(join(appDir, "Dockerfile")).exists()).toBe(isContainer);
    expect(await Bun.file(join(appDir, ".dockerignore")).exists()).toBe(isContainer);
  });

  // Build starts the agent in a box under opentelemetry-instrument, so a box template keeps OTEL on
  // as every other template does, and writes no instrumentation.
  test.each<RuntimeTemplateShortcutName>([
    "agent-python-strands-box",
    "agent-python-strands-box-container",
    "agent-python-minimal-box",
    "agent-python-langchain-box",
    "a2a-python-strands-box",
    "agui-python-strands-box",
    "agent-python-strands",
  ])("%s keeps enableOtel on", async (template) => {
    const { runtime } = await addTemplate("my_agent", template);
    expect(runtime.instrumentation).toBeUndefined();
  });

  // A box template is the Strands template with two files of agent-python-strands-box in place,
  // and one more README paragraph.
  test("agent-python-strands-box-container writes the Strands files, with its own Dockerfile and .gitignore", async () => {
    const files = async (dir: string) =>
      Object.fromEntries(
        await Promise.all(
          (await readdir(dir, { recursive: true, withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
              const path = relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
              return [path, await readFile(join(dir, path), "utf8")] as const;
            }),
        ),
      );
    const plain = await files(
      (await addTemplate("my_agent", "agent-python-strands-container")).appDir,
    );
    const box = await files(
      (await addTemplate("my_agent", "agent-python-strands-box-container")).appDir,
    );

    expect(Object.keys(box).sort()).toEqual(Object.keys(plain).sort());
    const {
      Dockerfile: boxDockerfile,
      ".gitignore": boxGitignore,
      "README.md": boxReadme,
      ...rest
    } = box;
    const {
      Dockerfile: plainDockerfile,
      ".gitignore": plainGitignore,
      "README.md": plainReadme,
      ...plainRest
    } = plain;
    expect(rest).toEqual(plainRest);
    // The box README adds one paragraph: its Box gateway calls only the model in modelId.
    const modelParagraph = boxReadme!.match(
      /\n\nOn AgentCore Runtime the Box gateway may call only[^\n]*\n/,
    )!;
    expect(boxReadme!.replace(modelParagraph[0], "\n")).toEqual(plainReadme!);
    expect(boxDockerfile).toContain("box run");
    expect(plainDockerfile).not.toContain("box run");
    expect(boxGitignore).toContain(".box-dist/");
    expect(plainGitignore).not.toContain(".box-dist/");
  });

  test.each<[RuntimeTemplateShortcutName, string]>([
    ["agent-python-langchain", "Traces are collected automatically"],
    ["agent-python-langchain-box", "Traces are not collected yet"],
  ])("%s's README says whether traces are collected", async (template, sentence) => {
    const { appDir } = await addTemplate("my_agent", template);
    const readme = await readFile(join(appDir, "README.md"), "utf8");

    expect(readme).toContain(sentence);
    expect(readme).not.toContain("{{");
  });

  test("Bedrock Managed Agents keeps infrastructure overrides and its required policy", async () => {
    const { runtime, appDir, core } = await addTemplate("my_bma", "environment-python-bma", {
      infra: {
        lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
        additionalPolicies: ["custom-policy.json"],
        tags: { team: "agents" },
      },
    });
    expect(runtime).toMatchObject({
      build: "Container",
      bedrockManagedAgents: true,
      entrypoint: "lifecycle/server.py",
      dockerfile: "Dockerfile",
      protocol: "HTTP",
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
      additionalPolicies: ["bma-acr-policy.json", "custom-policy.json"],
      tags: { "agentcore:template": "BedrockManagedAgents", team: "agents" },
    });
    // Local Python dependency setup is deferred to the container.
    expect(core.projectCommands).toEqual([]);
    expect(await Bun.file(join(appDir, "pyproject.toml")).exists()).toBe(true);
  });

  test.each<[RuntimeTemplateShortcutName, string[]]>([
    ["agent-python-strands", ["SEMANTIC", "EPISODIC"]],
    ["agent-python-strands-container", ["SEMANTIC", "EPISODIC"]],
    ["a2a-python-strands", ["SEMANTIC", "EPISODIC"]],
    ["agent-typescript-strands", ["SEMANTIC", "EPISODIC"]],
    ["agent-python-minimal", []],
    ["agent-python-langchain", []],
    ["agent-typescript-vercel", []],
    ["mcp-python-fastmcp", []],
    ["agui-python-strands", ["SEMANTIC", "EPISODIC"]],
    ["environment-python-bma", []],
  ])("%s ships with its pre-configured memory", async (template, expectedStrategies) => {
    const { spec, appDir } = await addTemplate("my_agent", template);
    const memory = (spec.memories ?? []).find(
      (candidate: { name: string }) => candidate.name === "my_agentMemory",
    );
    if (expectedStrategies.length === 0) {
      expect(memory).toBeUndefined();
      return;
    }
    expect(memory).toMatchObject({ name: "my_agentMemory", eventExpiryDuration: 30 });
    expect(memory.strategies.map(({ type }: { type: string }) => type)).toEqual(expectedStrategies);
    expect(memory.strategies).toEqual([
      { type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] },
      {
        type: "EPISODIC",
        namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
        reflectionNamespaceTemplates: ["/episodes/{actorId}"],
      },
    ]);

    const isTypeScript = template === "agent-typescript-strands";
    const memoryCode = await Bun.file(
      join(appDir, "memory", isTypeScript ? "memory.ts" : "session.py"),
    ).text();
    expect(memoryCode).not.toContain("/preferences");
    expect(memoryCode).not.toContain("/summaries/");
    if (isTypeScript) {
      expect(memoryCode).toContain("{ namespace: '/users/{actorId}/facts' }");
      expect(memoryCode).toContain("{ namespace: '/episodes/{actorId}/{sessionId}' }");
      expect(memoryCode.match(/namespace:/g)).toHaveLength(2);
    } else {
      expect(memoryCode).toContain(
        'f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.0)',
      );
      expect(memoryCode).toContain(
        'f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.0)',
      );
      expect(memoryCode.match(/RetrievalConfig\(/g)).toHaveLength(2);
    }
  });

  test.each<[RuntimeTemplateShortcutName, string]>([
    ["agent-typescript-strands", "main.ts"],
    ["agent-typescript-vercel", "main.ts"],
  ])("%s scaffolds a TypeScript runtime", async (template, file) => {
    const { runtime, appDir } = await addTemplate("my_agent", template);
    expect(runtime).toMatchObject({
      entrypoint: "main.js",
      build: "CodeZip",
      runtimeVersion: "NODE_22",
      protocol: "HTTP",
    });
    expect(await Bun.file(join(appDir, file)).exists()).toBe(true);
  });

  test("escapes quotes in the model id in the scaffolded model code", async () => {
    const { appDir } = await addTemplate("quoted", "agent-python-strands", {
      model: { modelProvider: "LiteLLM", modelId: 'openai/we"ird' },
    });
    const loadPy = await Bun.file(join(appDir, "model", "load.py")).text();
    expect(loadPy).toContain('model_id="openai/we\\"ird"');
  });

  test("OpenAICompatible renders the OpenAI client against the API base", async () => {
    const { spec, runtime, appDir } = await addTemplate("ds_agent", "agent-python-strands", {
      model: {
        modelProvider: "OpenAICompatible",
        modelId: "deepseek-chat",
        apiKey: "sk-ds",
        apiBase: "https://api.deepseek.com/v1",
      },
    });
    expect(runtime.modelProvider).toBe("OpenAICompatible");
    expect(spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "ds_agentOpenAICompatibleApiKey",
    });
    const loadModel = await Bun.file(join(appDir, "model", "load.py")).text();
    expect(loadModel).toContain('"base_url": "https://api.deepseek.com/v1"');
  });

  test("an API base is refused with a provider other than OpenAICompatible", () => {
    expect(() =>
      resolveRuntimeTemplateShortcut("agent-python-strands", {
        modelProvider: "Gemini",
        apiKey: "sk-g",
        apiBase: "https://example.com/v1",
      }),
    ).toThrow(/only supported with the openai_compatible model provider/);
  });

  // The create wizard is the only way to give a box template a model provider key. A boxed agent
  // cannot read AgentCore Identity: it reads the stand-in key the box sets under the credential's
  // variable, and the box puts the real key on each model call.
  test.each<[RuntimeTemplateShortcutName, ModelProvider]>([
    ["agent-python-strands-box", "OpenAI"],
    ["agent-python-strands-box", "Anthropic"],
    ["agent-python-strands-box", "Gemini"],
    ["agent-python-strands-box", "LiteLLM"],
    ["agent-python-strands-box-container", "OpenAI"],
    ["a2a-python-strands-box", "OpenAI"],
    ["agui-python-strands-box", "OpenAI"],
  ])(
    "%s with %s reads its API key from the box, not AgentCore Identity",
    async (template, provider) => {
      const { appDir } = await addTemplate("my_agent", template, {
        model: { modelProvider: provider, apiKey: "test-api-key" },
      });
      const loadPy = await Bun.file(join(appDir, "model", "load.py")).text();
      expect(loadPy).not.toContain("requires_api_key");
      expect(loadPy).not.toContain("LOCAL_DEV");
      expect(loadPy).toContain(
        `IDENTITY_ENV_VAR = "${credentialEnvVarName(`my_agent${provider}ApiKey`)}"`,
      );
      expect(loadPy).toContain("api_key = os.getenv(IDENTITY_ENV_VAR)");
    },
  );

  test.each<RuntimeTemplateShortcutName>([
    "agent-python-strands",
    "a2a-python-strands",
    "agui-python-strands",
  ])("%s with a model provider key still reads it from AgentCore Identity", async (template) => {
    const { appDir } = await addTemplate("my_agent", template, {
      model: { modelProvider: "OpenAI", apiKey: "test-api-key" },
    });
    const loadPy = await Bun.file(join(appDir, "model", "load.py")).text();
    expect(loadPy).toContain("@requires_api_key(provider_name=IDENTITY_PROVIDER_NAME)");
    expect(loadPy).toContain('if os.getenv("LOCAL_DEV") == "1":');
  });

  test.each<ModelProvider>(["Anthropic", "OpenAI", "Gemini"])(
    "%s scaffolds agent-python-strands with an API-key credential",
    async (provider) => {
      const { projectRoot, spec } = await addTemplate("my_agent", "agent-python-strands", {
        model: { modelProvider: provider, apiKey: "test-api-key" },
      });
      const credentialName = `my_agent${provider}ApiKey`;
      expect(spec.credentials).toContainEqual({
        authorizerType: "ApiKeyCredentialProvider",
        name: credentialName,
      });
      const envPath = join(projectRoot, "agentcore", ".env.local");
      expect(await Bun.file(envPath).text()).not.toContain("test-api-key");
      expect((await readEnvFile(envPath))[credentialEnvVarName(credentialName)]).toBe(
        "test-api-key",
      );
    },
  );

  // dev/build/deploy re-derive build settings from the code and write changes
  // back; a freshly scaffolded template must already agree with its own code.
  test.each([...RUNTIME_TEMPLATE_SHORTCUT_NAMES])(
    "%s resolves to the settings it was scaffolded with",
    async (template) => {
      const { projectRoot, spec } = await addTemplate("my_agent", template);
      const prepared = prepareRuntimes(projectRoot, spec.runtimes, "dev");
      expect(prepared.changed).toEqual([]);
      expect(prepared.messages).toEqual([]);
    },
  );

  test("a translated Bedrock Agent import resolves to the settings it was scaffolded with", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const project = (await core.projectManager.resolve({ filePath: projectRoot }))!;
    const generator = core.projectManager.addResource(
      project,
      toAddRuntimeInput({
        name: "imported",
        envVars: [],
        scaffoldRuntimeInput: importScaffoldRuntimeInput("imported"),
        importBedrockAgent: {
          framework: "strands",
          sourceAgentId: "A1B2C3D4E5",
          sourceAgentAliasId: "TSTALIASID",
          sourceAgentVersion: "1",
          files: {
            "main.py": "from strands import Agent\n",
            "pyproject.toml": '[project]\nname = "imported"\nrequires-python = ">=3.10"\n',
          },
          notes: [],
        },
      }),
    );
    for (let step = await generator.next(); !step.done; step = await generator.next());
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();

    const prepared = prepareRuntimes(projectRoot, spec.runtimes, "dev");
    expect(prepared.changed).toEqual([]);
    expect(prepared.messages).toEqual([]);
  });
});
