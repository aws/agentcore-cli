import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "zod";
import { E2E_PREFIX, TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { retry } from "../helpers/retry";
import { TIMEOUT_MS } from "../timeouts";

type HarnessTestCase = {
  name: string;
  addFlags: string[];
  invokeFlags: string[];
  expectedText?: string;
};

const CUSTOM_PROMPT_RESPONSE = "HARNESS_PROMPT_VERIFIED";
const HARNESS_TEST_CASES: HarnessTestCase[] = [
  {
    name: "managed_memory",
    addFlags: [],
    invokeFlags: ["--prompt", "Reply with a short greeting."],
  },
  {
    name: "disabled_memory",
    addFlags: ["--memory", JSON.stringify({ mode: "disabled" })],
    invokeFlags: ["--prompt", "Reply with a short greeting."],
  },
  {
    name: "semantic_memory",
    addFlags: ["--memory", JSON.stringify({ mode: "managed", strategies: ["SEMANTIC"] })],
    invokeFlags: ["--prompt", "Reply with a short greeting."],
  },
  {
    name: "custom_prompt",
    addFlags: [
      "--system-prompt",
      `Reply with exactly ${CUSTOM_PROMPT_RESPONSE} and no other text.`,
    ],
    invokeFlags: ["--prompt", "Respond now."],
    expectedText: CUSTOM_PROMPT_RESPONSE,
  },
];

const ProjectCreatedSchema = z.object({
  project: z.object({ path: z.string() }),
});
const OperationSchema = z.object({ operation: z.string() });
const DeployResponseSchema = z.object({ message: z.string() });
const TranscriptItemSchema = z
  .object({
    kind: z.string(),
    text: z.string().optional(),
  })
  .passthrough();
const HarnessInvokeResponseSchema = z.object({
  sessionId: z.string().min(33).max(100),
  transcript: z.array(TranscriptItemSchema).min(2),
});

const responseText = (response: z.infer<typeof HarnessInvokeResponseSchema>) =>
  response.transcript
    .filter((item) => item.kind === "text")
    .flatMap((item) => item.text ?? [])
    .join("");

const harnessTags = [TAGS.HARNESS, TAGS.CANARY];
describe("add, deploy, and invoke harnesses", { sequential: true, tags: harnessTags }, () => {
  const cli = new CliRunner();
  const projectName = `${E2E_PREFIX}${Date.now().toString(36)}`;
  let projectDir: string;

  beforeAll(async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "agentcore-e2e-"));
    const created = parseResult(
      ProjectCreatedSchema,
      await cli.run(
        ["create", "--name", projectName, "--template", "empty", "--skip-git", "--json"],
        projectRoot,
      ),
    );
    projectDir = created.project.path;
  }, TIMEOUT_MS.PROJECT_CREATE);

  test.each(HARNESS_TEST_CASES)(
    "$name can be added to a project",
    { timeout: TIMEOUT_MS.PROJECT_ADD },
    async (harness) => {
      const added = parseResult(
        OperationSchema,
        await cli.run(
          ["add", "harness", "--name", harness.name, "--json", ...harness.addFlags],
          projectDir,
        ),
      );
      expect(added.operation).toBe("add");
    },
  );

  describe.skipIf(process.arch !== "arm64")("local invocation", { sequential: true }, () => {
    const sessionId = (label: string) => `${label}${Date.now().toString(36)}`.padEnd(40, "x");
    let dev: ReturnType<CliRunner["start"]> | undefined;
    let devOutput = "";
    let port: number | undefined;

    beforeAll(() => {
      dev = cli.start(["dev", "--mode", "headless"], projectDir);
      const capture = (chunk: Buffer) => {
        devOutput += chunk.toString();
        const match = devOutput.match(/Harness endpoint listening on port (\d+)\./);
        if (match?.[1]) port = Number(match[1]);
      };
      dev.stdout.on("data", capture);
      dev.stderr.on("data", capture);
    }, TIMEOUT_MS.PROJECT_DEV);

    afterAll(async () => {
      if (!dev || dev.exitCode !== null) return;
      dev.kill("SIGTERM");
      await new Promise<void>((resolve) => dev?.once("close", resolve));
    });

    const invoke = (prompt: string, session: string) =>
      retry(async () => {
        if (!dev || dev.exitCode !== null) {
          throw new Error(`agentcore dev exited.\nstdout/stderr = ${devOutput}`);
        }
        if (port === undefined) {
          throw new Error(`Harness endpoint is not ready.\nstdout/stderr = ${devOutput}`);
        }
        return parseResult(
          HarnessInvokeResponseSchema,
          await cli.run(
            [
              "invoke",
              "--harness",
              "disabled_memory",
              "--local",
              "--port",
              String(port),
              "--prompt",
              prompt,
              "--session-id",
              session,
              "--json",
            ],
            projectDir,
          ),
        );
      }, TIMEOUT_MS.PROJECT_INVOKE * 0.9);

    test(
      "disabled_memory keeps history within a session and drops it for a new one",
      { timeout: TIMEOUT_MS.PROJECT_INVOKE * 3 },
      async () => {
        const session = sessionId("harnesslocala");
        await invoke("Remember the word zephyr. Reply with OK.", session);
        const same = await invoke(
          "What word did I ask you to remember? Reply with the word only.",
          session,
        );
        const fresh = await invoke(
          "What word did I ask you to remember? If none, reply NONE.",
          sessionId("harnesslocalb"),
        );

        expect(same.sessionId).toBe(session);
        expect(responseText(same).toLowerCase()).toContain("zephyr");
        expect(responseText(fresh).toLowerCase()).not.toContain("zephyr");
      },
    );
  });

  test("deploys all harnesses", { timeout: TIMEOUT_MS.PROJECT_DEPLOY }, async () => {
    const deployment = parseResult(
      DeployResponseSchema,
      await cli.run(["deploy", "--yes", "--json"], projectDir),
    );
    expect(deployment.message).toContain("Deployed project");
  });

  test.each(HARNESS_TEST_CASES)(
    "$name can be invoked after deployed",
    { concurrent: true, timeout: TIMEOUT_MS.PROJECT_INVOKE },
    async (harness) => {
      const response = parseResult(
        HarnessInvokeResponseSchema,
        await cli.run(
          ["invoke", "--harness", harness.name, "--json", ...harness.invokeFlags],
          projectDir,
        ),
      );
      const text = responseText(response);

      expect(text.trim()).not.toBe("");
      if (harness.expectedText) expect(text).toContain(harness.expectedText);
    },
  );

  test(
    "removes all harnesses and deploys the empty project",
    { timeout: TIMEOUT_MS.PROJECT_REMOVE + TIMEOUT_MS.PROJECT_DEPLOY },
    async () => {
      const removed = parseResult(
        OperationSchema,
        await cli.run(["remove", "all", "--yes", "--json"], projectDir),
      );
      expect(removed.operation).toBe("remove");

      const deployment = parseResult(
        DeployResponseSchema,
        await cli.run(["deploy", "--yes", "--json"], projectDir),
      );
      expect(deployment.message).toContain("Removed project");
    },
  );
});
