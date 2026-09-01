import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import z from "zod";
import { FsProjectManager } from "./manager";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import type { ExportHarnessInput, Project, ProjectEvent } from "../../handlers/project/types";
import { HarnessSpecSchema } from "../../projectSchemas/harness";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-export-manager-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function manager(options: { json?: ReadWriteJson } = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      json: options.json,
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
      },
      checkTool: async () => {},
    }),
    commands,
  };
}

async function drain<T>(generator: AsyncGenerator<ProjectEvent, T>): Promise<T> {
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

/** Creates a project with a harness built from `harness` overrides; returns the refreshed project. */
async function projectWithHarness(
  subject: FsProjectManager,
  harness: Record<string, unknown> = {},
): Promise<Project> {
  await inTempDirectory();
  let project = await drain(
    subject.create({
      name: "orders",
      skipInstall: true,
      skipGit: true,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("hello-world-python"),
    }),
  );
  project = await drain(
    subject.addResource(project, {
      resourceType: "harness",
      resourceConfig: {
        name: "assistant",
        model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
        systemPrompt: "You are a terse assistant.",
        ...harness,
      } as z.input<typeof HarnessSpecSchema>,
    }),
  );
  return project;
}

function exportInput(overrides: Partial<ExportHarnessInput> = {}): ExportHarnessInput {
  return { harnessName: "assistant", targetAgentName: "assistantAgent", ...overrides };
}

describe("FsProjectManager.exportHarness rendered tree", () => {
  test("includes hooks/ only when the harness sets execution limits", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, { maxIterations: 3 });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "hooks", "execution_limits.py"))).toBe(true);
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain(
      "from hooks.execution_limits import ExecutionLimitExceeded, ExecutionLimitsHook",
    );
    expect(main).toContain("max_iterations=3,");
  });

  test("leaves hooks/ and memory/ out of a plain export", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "hooks"))).toBe(false);
    expect(existsSync(join(result.agentPath, "memory"))).toBe(false);
    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
  });

  test("wires an in-project memory through memory/session.py", async () => {
    const { manager: subject } = manager();
    let project = await projectWithHarness(subject, {
      memory: { mode: "existing", name: "chat_history" },
    });
    project = await drain(
      subject.addResource(project, {
        resourceType: "memory",
        resourceConfig: {
          name: "chat_history",
          eventExpiryDuration: 30,
          strategies: [{ type: "SEMANTIC" }],
        },
      }),
    );

    const result = await drain(subject.exportHarness(project, exportInput()));

    const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
    expect(session).toContain('MEMORY_ID = os.getenv("MEMORY_CHAT_HISTORY_ID")');
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain(
      "from memory.session import get_memory_session_manager",
    );
    expect(result.notes).toEqual([]);
  });

  test("renders the template Dockerfile for a plain Container export", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput({ build: "Container" })));

    expect(await Bun.file(join(result.agentPath, "Dockerfile")).text()).toContain("uv sync");
    expect(existsSync(join(result.agentPath, ".dockerignore"))).toBe(true);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.build).toBe("Container");
    expect(runtime.dockerfile).toBe("Dockerfile");
  });

  test("writes a FROM stub for a containerUri harness", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      containerUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/base-image:latest",
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(await Bun.file(join(result.agentPath, "Dockerfile")).text()).toContain(
      "FROM 111122223333.dkr.ecr.us-east-1.amazonaws.com/base-image:latest",
    );
    expect(result.notes.map((note) => note.category)).toEqual([
      "containerUri: verify Python in base image",
    ]);
  });

  test("writes generated IAM policy files next to the code", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      skills: [{ s3Uri: "s3://skills-bucket/team" }],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const policy = await Bun.file(join(result.agentPath, "s3-skills-policy.json")).json();
    expect(policy.Statement[0].Resource).toEqual(["arn:aws:s3:::skills-bucket/team/*"]);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.additionalPolicies).toEqual(["s3-skills-policy.json"]);
  });
});

describe("FsProjectManager.exportHarness side effects", () => {
  test("writes MCP header secrets to .env.local and registers their credentials", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "internal",
          config: {
            remoteMcp: { url: "https://mcp.internal.example", headers: { "X-Api-Key": "s3cret" } },
          },
        },
      ],
    });

    await drain(subject.exportHarness(project, exportInput()));

    const envLocal = await Bun.file(join(project.rootPath, "agentcore", ".env.local")).text();
    expect(envLocal).toContain("AGENTCORE_CREDENTIAL_ORDERSMCPINTERNALXAPIKEY='s3cret'");
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    expect(spec.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "ordersMcpinternalXApiKey" },
    ]);
  });

  test("exports a prefetched (service) harness without touching harness files", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(
      subject.exportHarness(project, {
        prefetched: {
          spec: HarnessSpecSchema.parse({
            name: "remote_harness",
            model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
          }),
          systemPrompt: "Fetched prompt.",
        },
        targetAgentName: "exported_arn",
      }),
    );

    expect(result.harnessName).toBe("remote_harness");
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain("Fetched prompt.");
  });

  test("cleans up the agent dir and .env.local when the spec write fails", async () => {
    const failing = failingWriteJson();
    const { manager: subject } = manager({ json: failing.json });
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "internal",
          config: {
            remoteMcp: { url: "https://mcp.internal.example", headers: { "X-Api-Key": "s3cret" } },
          },
        },
      ],
    });

    failing.failNextWrite();
    await expect(drain(subject.exportHarness(project, exportInput()))).rejects.toThrow("disk full");

    expect(existsSync(join(project.rootPath, "app", "assistantAgent"))).toBe(false);
    // The scaffolded .env.local survives, but the staged secret is rolled back.
    expect(await Bun.file(join(project.rootPath, "agentcore", ".env.local")).text()).not.toContain(
      "AGENTCORE_CREDENTIAL_ORDERSMCPINTERNALXAPIKEY",
    );
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes.map((r: { name: string }) => r.name)).not.toContain("assistantAgent");
  });

  test("reads the harness from its registry path", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", maxTokens: 128 },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(await Bun.file(join(result.agentPath, "model", "load.py")).text()).toContain(
      "max_tokens=128",
    );
    // The system prompt comes from system-prompt.md, the file add-harness wrote.
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """You are a terse assistant."""',
    );
  });
});

/** A ReadWriteJson that can be told to fail its next write, delegating otherwise. */
function failingWriteJson() {
  const real = new FsReadWriteJson({ logger: createSilentLogger() });
  let shouldFail = false;
  const json: ReadWriteJson = {
    read: (path, schema) => real.read(path, schema),
    write: (path, data) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("disk full");
      }
      return real.write(path, data);
    },
  };
  return { json, failNextWrite: () => (shouldFail = true) };
}
