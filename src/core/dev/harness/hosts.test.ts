import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InputValidationError,
  InvalidEnvironmentError,
  ResourceNotFoundError,
} from "../../../errors";
import type { HarnessDevAws } from "../../../handlers/project/dev/types";
import { ProcessFailedError, type ProcessEvent, type StreamProcessOptions } from "../../../io";
import { waitFor } from "../../../testing";
import { HarnessDevHosts, type HarnessHostEvent } from "./hosts";

type FakeRuntime = {
  requests: { path: string; headers: Headers; body: unknown }[];
  port: number;
  serving: boolean;
};
type RunBehavior = "serve" | "exec-format" | "exit";

let root: string;
let fakeRuntime: FakeRuntime & { stop(): void };
let controller: AbortController;

const model = { bedrockModelConfig: { modelId: "m1" } };
const SSE = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } } },
  { messageStop: { stopReason: "end_turn" } },
];

function startFakeRuntime(): FakeRuntime & { stop(): void } {
  const requests: FakeRuntime["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/ping") return new Response(null, { status: fakeRuntime.serving ? 200 : 503 });
      requests.push({ path, headers: request.headers, body: await request.json() });
      const body = SSE.map((event) => `data: ${JSON.stringify({ event })}\n\n`).join("");
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { requests, port: server.port!, serving: false, stop: () => server.stop(true) };
}

async function writeHarness(name: string, spec: Record<string, unknown> = {}) {
  const dir = join(root, "agentcore", "harnesses", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "harness.yaml"), JSON.stringify({ name, model, ...spec }));
  return { name, path: join("agentcore", "harnesses", name) };
}

function aws(overrides: Partial<HarnessDevAws> = {}): HarnessDevAws & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deployedHarness: async (name) => {
      calls.push(`deployed:${name}`);
      return undefined;
    },
    workloadAccessToken: async () => {
      calls.push("token");
      return { token: "tok" };
    },
    ...overrides,
  };
}

function hosts(
  entries: { name: string; path: string }[],
  options: {
    aws?: HarnessDevAws;
    pullDelayMs?: number;
    run?: () => RunBehavior;
  } = {},
) {
  const commands: string[][] = [];
  const streamProcess = async function* (
    command: string[],
    processOptions: StreamProcessOptions,
  ): AsyncGenerator<ProcessEvent, void> {
    commands.push(command);
    const [, verb] = command;
    if (verb === "image") {
      if (!commands.some(([, candidate]) => candidate === "pull")) throw new Error("No such image");
      yield { type: "stdout", line: "sha256:digest" };
    }
    if (verb === "pull" && options.pullDelayMs) await Bun.sleep(options.pullDelayMs);
    if (verb === "run") {
      const behavior = options.run?.() ?? "serve";
      if (behavior !== "serve") {
        const line = behavior === "exit" ? "boom" : "exec /usr/bin/python3: exec format error";
        yield { type: "stderr", line };
        throw new ProcessFailedError(command, processOptions.cwd, 1, line);
      }
      yield { type: "stdout", line: "runtime listening" };
      fakeRuntime.serving = true;
      await new Promise((resolve) =>
        processOptions.signal?.addEventListener("abort", resolve, { once: true }),
      );
      fakeRuntime.serving = false;
    }
  };
  const subject = new HarnessDevHosts({
    project: { name: "proj", rootPath: root },
    harnesses: entries,
    region: "us-west-2",
    aws: options.aws ?? aws(),
    environment: async () => ({}),
    hostPort: async () => fakeRuntime.port,
    signal: controller.signal,
    streamProcess,
    toolAvailable: async (tool) => tool === "docker",
    credentials: async () => ({ accessKeyId: "a", secretAccessKey: "s" }),
    processEnv: {},
    readyIntervalMs: 5,
  });
  return { subject, commands };
}

async function drain(
  turn: { events: AsyncGenerator<unknown> } | Promise<{ events: AsyncGenerator<unknown> }>,
) {
  return Array.fromAsync((await turn).events);
}

function statuses(events: HarnessHostEvent[]): string[] {
  return events.flatMap(({ event }) => (event.type === "status" ? [event.message] : []));
}

const collectEvents = (subject: HarnessDevHosts) => Array.fromAsync(subject.events());

const verbs = (commands: string[][]) => commands.map(([, verb]) => verb);
const count = (commands: string[][], verb: string) =>
  verbs(commands).filter((candidate) => candidate === verb).length;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-hosts-"));
  fakeRuntime = startFakeRuntime();
  controller = new AbortController();
});
afterEach(async () => {
  controller.abort();
  fakeRuntime.stop();
  await rm(root, { recursive: true, force: true });
});

describe("lifecycle", () => {
  test("starts lazily and streams native events", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")]);
    expect(verbs(commands)).toEqual([]);

    const events = await drain(subject.invoke("h1", { prompt: "hello" }, controller.signal));

    expect(events).toEqual(SSE);
    expect(verbs(commands)).toEqual(["image", "pull", "image", "rm", "run"]);
    expect(
      fakeRuntime.requests[0]!.headers.get("x-amzn-bedrock-agentcore-runtime-session-id"),
    ).toBeTruthy();
  });

  test("reuses the container for the same session and restarts for a new one", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")]);

    await drain(subject.invoke("h1", { prompt: "a", sessionId: "s1" }, controller.signal));
    await drain(subject.invoke("h1", { prompt: "b", sessionId: "s1" }, controller.signal));
    expect(count(commands, "run")).toBe(1);

    await drain(subject.invoke("h1", { prompt: "c", sessionId: "s2" }, controller.signal));
    expect(count(commands, "run")).toBe(2);
    expect(subject.snapshot()).toEqual([{ name: "h1", phase: "running", sessionId: "s2" }]);
  });

  test("rejects a second turn while one streams", async () => {
    const { subject } = hosts([await writeHarness("h1")]);
    const first = await subject.invoke("h1", { prompt: "a", sessionId: "s1" }, controller.signal);

    const second = subject.invoke("h1", { prompt: "b", sessionId: "s2" }, controller.signal);

    await expect(second).rejects.toBeInstanceOf(InputValidationError);
    await expect(second).rejects.toThrow("busy");
    await expect(subject.start("h1")).rejects.toThrow("busy");
    await drain(first);
  });

  test("start runs the container, and an invoke during start reuses it", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")], { pullDelayMs: 20 });
    const events = collectEvents(subject);

    const started = subject.start("h1");
    expect(await drain(subject.invoke("h1", { prompt: "a" }, controller.signal))).toEqual(SSE);
    await started;
    controller.abort();

    expect(count(commands, "run")).toBe(1);
    expect(
      (await events).flatMap(({ agentName, event }) =>
        event.type === "status" ? [[agentName, event.message]] : [],
      ),
    ).toEqual([
      [undefined, expect.stringMatching(/^Pulling /)],
      [undefined, expect.stringMatching(/^Image ready /)],
      ["h1", "Starting container"],
      ["h1", "Ready"],
    ]);
  });

  test("removed while start pulls stops after the start", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")], { pullDelayMs: 20 });
    const started = subject.start("h1");
    await waitFor(() => verbs(commands).includes("pull"));

    subject.setHarnesses([]);
    await started;

    await waitFor(() => verbs(commands).lastIndexOf("rm") > verbs(commands).indexOf("run"));
    expect(subject.snapshot()).toEqual([]);
  });

  test("an invoke waiting on a failed start of a removed host is not found and runs no second container", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")], {
      pullDelayMs: 20,
      run: () => "exit",
    });
    const started = subject.start("h1");
    const invoked = subject.invoke("h1", { prompt: "a" }, controller.signal);
    await waitFor(() => verbs(commands).includes("pull"));

    subject.setHarnesses([]);

    const [start, invoke] = await Promise.allSettled([started, invoked]);
    expect(start).toMatchObject({
      status: "rejected",
      reason: expect.any(InvalidEnvironmentError),
    });
    expect(invoke).toMatchObject({ status: "rejected", reason: expect.any(ResourceNotFoundError) });
    expect(count(commands, "run")).toBe(1);
    expect(subject.snapshot()).toEqual([]);
  });

  test("remove and re-add during an idle start keeps one host and one run", async () => {
    const h1 = await writeHarness("h1");
    const { subject, commands } = hosts([h1], { pullDelayMs: 20 });
    const started = subject.start("h1");
    await waitFor(() => verbs(commands).includes("pull"));

    subject.setHarnesses([]);
    subject.setHarnesses([h1]);
    await started;
    const events = await drain(subject.invoke("h1", { prompt: "a" }, controller.signal));

    expect(events).toEqual(SSE);
    expect(count(commands, "run")).toBe(1);
    expect(subject.snapshot()).toMatchObject([{ name: "h1", phase: "running" }]);
  });

  test("an unsupported spec field is rejected by name before any container runs", async () => {
    const { subject, commands } = hosts([
      await writeHarness("h1", {
        environmentArtifact: {
          containerConfiguration: {
            containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/r:t",
          },
        },
      }),
    ]);

    await expect(subject.invoke("h1", { prompt: "a" }, controller.signal)).rejects.toBeInstanceOf(
      InputValidationError,
    );
    expect(verbs(commands)).toEqual([]);
  });

  test.each([
    ["exec format error becomes an arm64 error", "exec-format", /arm64 only/],
    [
      "an early exit reports the last stderr lines",
      "exit",
      /exited before it was ready\.\n[\s\S]*boom/,
    ],
  ] as const)("%s and the next invoke recovers", async (_case, failure, message) => {
    const behaviors: RunBehavior[] = [failure, "serve"];
    const { subject } = hosts([await writeHarness("h1")], { run: () => behaviors.shift()! });

    const failed = subject.invoke("h1", { prompt: "a" }, controller.signal);
    await expect(failed).rejects.toBeInstanceOf(InvalidEnvironmentError);
    await expect(failed).rejects.toThrow(message);
    expect(subject.snapshot()[0]!.phase).toBe("failed");

    expect(await drain(subject.invoke("h1", { prompt: "b" }, controller.signal))).toEqual(SSE);
  });

  test("setHarnesses adds a harness and removes another", async () => {
    const { subject } = hosts([await writeHarness("h1")]);
    const added = await writeHarness("h2");

    subject.setHarnesses([added]);

    expect(await drain(subject.invoke("h2", { prompt: "a" }, controller.signal))).toEqual(SSE);
    await expect(subject.invoke("h1", { prompt: "a" }, controller.signal)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test("removed mid turn stops after the turn", async () => {
    const h1 = await writeHarness("h1");
    const { subject, commands } = hosts([h1]);
    const turn = await subject.invoke("h1", { prompt: "a" }, controller.signal);
    const before = count(commands, "rm");

    subject.setHarnesses([]);
    expect(count(commands, "rm")).toBe(before);
    await drain(turn);

    await waitFor(() => count(commands, "rm") > before);
    expect(subject.snapshot()).toEqual([]);
  });

  test("re-added mid turn keeps its container", async () => {
    const h1 = await writeHarness("h1");
    const { subject, commands } = hosts([h1]);
    const turn = await subject.invoke("h1", { prompt: "a", sessionId: "s1" }, controller.signal);

    subject.setHarnesses([]);
    subject.setHarnesses([h1]);
    await drain(turn);
    await drain(subject.invoke("h1", { prompt: "b", sessionId: "s1" }, controller.signal));

    expect(count(commands, "run")).toBe(1);
    expect(subject.snapshot()).toEqual([{ name: "h1", phase: "running", sessionId: "s1" }]);
  });

  test("abort removes every container, its credentials, and ends events", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")]);
    await drain(subject.invoke("h1", { prompt: "a" }, controller.signal));
    const run = commands.find(([, verb]) => verb === "run")!;
    const credentials = run[run.indexOf("-v") + 1]!.split(":")[0]!;
    expect(existsSync(join(credentials, "credentials.json"))).toBe(true);
    const events = collectEvents(subject);

    controller.abort();
    await events;

    expect(commands.at(-1)).toEqual(["docker", "rm", "-f", "agentcore-dev-harness-proj-h1"]);
    expect(existsSync(credentials)).toBe(false);
  });
});

describe("pull", () => {
  test("one pull shared by pullImage and invoke", async () => {
    const { subject, commands } = hosts([await writeHarness("h1")], { pullDelayMs: 20 });

    await Promise.all([
      subject.pullImage(),
      drain(subject.invoke("h1", { prompt: "a" }, controller.signal)),
    ]);

    expect(count(commands, "pull")).toBe(1);
  });
});

describe("turn inputs and tokens", () => {
  const API_KEY_MODEL = { model: { openAiModelConfig: { modelId: "m", apiKeyArn: "k" } } };

  test("the prompt file is read on every turn", async () => {
    const { subject } = hosts([await writeHarness("h1")]);
    const promptPath = join(root, "agentcore", "harnesses", "h1", "system-prompt.md");
    await writeFile(promptPath, "first");
    await drain(subject.invoke("h1", { prompt: "a", sessionId: "s" }, controller.signal));
    await writeFile(promptPath, "second");
    await drain(subject.invoke("h1", { prompt: "b", sessionId: "s" }, controller.signal));

    const prompts = fakeRuntime.requests.map(
      (request) =>
        (request.body as { invokePayload: { systemPrompt: unknown } }).invokePayload.systemPrompt,
    );
    expect(prompts).toEqual([[{ text: "first" }], [{ text: "second" }]]);
  });

  test("references without a deployed target warn once per start", async () => {
    const { subject } = hosts([
      await writeHarness("h1", {
        memory: { managedMemoryConfiguration: {} },
        skills: [{ git: { url: "https://g/r", auth: { credentialName: "gitcred" } } }],
      }),
    ]);
    const events = collectEvents(subject);
    await drain(subject.invoke("h1", { prompt: "a", sessionId: "s" }, controller.signal));
    await drain(subject.invoke("h1", { prompt: "b", sessionId: "s" }, controller.signal));
    controller.abort();

    expect(statuses(await events).filter((line) => line.startsWith("Target not deployed"))).toEqual(
      [
        "Target not deployed, so running without: memory, git skill https://g/r. Deploy the target to use them locally.",
      ],
    );
  });

  test.each([
    ["an apiKeyArn model sends a fresh token per turn", API_KEY_MODEL, "tok", ["token", "token"]],
    ["a bedrock model sends no token", {}, null, []],
  ] as const)("%s", async (_case, spec, token, calls) => {
    const fake = aws({
      workloadAccessToken: async () => {
        const first = !fake.calls.includes("token");
        fake.calls.push("token");
        return { token: "tok", createdIdentity: first ? "agentcore-dev-proj-default" : undefined };
      },
    });
    const { subject } = hosts([await writeHarness("h1", spec)], { aws: fake });
    const events = collectEvents(subject);

    await drain(subject.invoke("h1", { prompt: "a", sessionId: "s" }, controller.signal));
    await drain(subject.invoke("h1", { prompt: "b", sessionId: "s" }, controller.signal));
    controller.abort();

    expect(
      fakeRuntime.requests.map((request) =>
        request.headers.get("x-amzn-bedrock-agentcore-workload-access-token"),
      ),
    ).toEqual([token, token]);
    expect(fake.calls.filter((call) => call !== "deployed:h1")).toEqual([...calls]);
    expect(
      statuses(await events).includes(
        "Created workload identity 'agentcore-dev-proj-default' for API key models. Target teardown deletes it. To delete it sooner: aws bedrock-agentcore-control delete-workload-identity --name agentcore-dev-proj-default",
      ),
    ).toBe(token !== null);
  });
});
