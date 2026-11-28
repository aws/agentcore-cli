import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { retry } from "../helpers/retry";
import {
  BOX_DEPLOYS,
  BOX_TEMPLATES,
  OperationSchema,
  CREATED_RUNTIME_NAME,
  MEMORY_AGENT,
  addConnection,
  allowBrowserWebSocket,
  CODE_INTERPRETER_AGENT,
  BROWSER_AGENT,
  assertRunsInBox,
  deployed,
  ask,
  askAgent,
  DEPLOY_TEST_TIMEOUT,
  createTemplateProject,
  getSessionId,
} from "./templates-test-support";

// Box project scenarios on AgentCore Runtime that a user hits beyond one template's happy path: a
// second runtime beside the first's Memory, a Memory added with `add memory`, a Code Interpreter
// and a Browser connection, and Memory that recalls within a session and across sessions. Each
// deploys its own project; they run concurrently. They reach only AWS hosts; the scenarios that
// need a public host are in the box-egress suite above. They need the AGENTCORE_E2E_BOX_CDK
// opt-in, as the flow tests do.
describe.skipIf(!BOX_DEPLOYS)(
  "Box project scenarios on AgentCore Runtime",
  { tags: [TAGS.BOX] },
  () => {
    const cli = new CliRunner();
    const strands = BOX_TEMPLATES.find((t) => t.template === "agent-python-strands-box");
    const minimal = BOX_TEMPLATES.find((t) => t.template === "agent-python-minimal-box");
    if (!strands || !minimal)
      throw new Error("BOX_TEMPLATES lacks the strands or minimal box case");

    // A Box project's runtimes each run in a box, and the box pack of each reads the ID of every
    // project Memory, so a runtime added beside the first, whose Memory it gets, must start.
    test.concurrent(
      "a runtime added to a Box project with a Memory deploys and answers beside the first",
      { timeout: DEPLOY_TEST_TIMEOUT },
      async () => {
        const projectDir = await createTemplateProject(cli, strands, { deploys: true });
        const added = parseResult(
          OperationSchema,
          await cli.run(
            ["add", "runtime", "--name", "second", "--language", "python", "--json"],
            projectDir,
          ),
        );
        expect(added.operation).toBe("add");
        // add runtime writes start.py and the docs; the agent code is the user's, here the first's.
        const from = join(projectDir, "app", CREATED_RUNTIME_NAME);
        const to = join(projectDir, "app", "second");
        for (const entry of [
          "main.py",
          "pyproject.toml",
          "uv.lock",
          "model",
          "memory",
          "parse.py",
        ]) {
          // The first's code must reach the second; the other files only when the template has
          // them.
          if (entry === "main.py" || existsSync(join(from, entry))) {
            await cp(join(from, entry), join(to, entry), { recursive: true });
          }
        }
        await deployed(cli, projectDir, async () => {
          await ask(
            cli,
            projectDir,
            CREATED_RUNTIME_NAME,
            getSessionId("box-two-a"),
            "Reply with a short greeting.",
          );
          await ask(
            cli,
            projectDir,
            "second",
            getSessionId("box-two-b"),
            "Reply with a short greeting.",
          );
          await assertRunsInBox(cli, projectDir, "second");
        });
      },
    );

    // A Memory added with `add memory` is a project Memory like the default one: the runtime gets
    // its ID, and box sends the agent's calls to it to Memory directly, signed with the execution
    // role. The minimal template has no Memory of its own, so this Memory is the project's only
    // one.
    test.concurrent(
      "a Memory added with add memory takes and returns an event of the boxed agent",
      { timeout: DEPLOY_TEST_TIMEOUT },
      async () => {
        const projectDir = await createTemplateProject(cli, minimal, { deploys: true });
        const added = parseResult(
          OperationSchema,
          await cli.run(["add", "memory", "--name", "notes", "--json"], projectDir),
        );
        expect(added.operation).toBe("add");
        await writeFile(join(projectDir, "app", CREATED_RUNTIME_NAME, "main.py"), MEMORY_AGENT);
        const note = `note-${Date.now().toString(36)}`;
        await deployed(cli, projectDir, async () => {
          await askAgent<{ stored?: string[]; error?: string }>(
            cli,
            projectDir,
            getSessionId("box-notes"),
            note,
            (reply) => expect(reply.stored).toContain(note),
          );
          await assertRunsInBox(cli, projectDir);
        });
      },
    );

    // A runtime reaches the AWS-managed Code Interpreter through a `codeInterpreter` connection in
    // agentcore.json, which grants its role the tool. Its calls go to the AgentCore host, which box
    // sends directly, signed with the execution role, because the project has a Memory.
    test.concurrent(
      "a Code Interpreter connection runs code for the boxed agent",
      { timeout: DEPLOY_TEST_TIMEOUT },
      async () => {
        const projectDir = await createTemplateProject(cli, strands, { deploys: true });
        await addConnection(projectDir, "codeInterpreter");
        await writeFile(
          join(projectDir, "app", CREATED_RUNTIME_NAME, "main.py"),
          CODE_INTERPRETER_AGENT,
        );
        await deployed(cli, projectDir, async () => {
          await askAgent<{ output?: string; error?: string }>(
            cli,
            projectDir,
            getSessionId("box-code"),
            "run",
            (reply) => expect(reply.output).toContain("42"),
          );
          await assertRunsInBox(cli, projectDir);
        });
      },
    );

    // A runtime reaches the AWS-managed Browser through a `browser` connection. The agent starts a
    // session over the AgentCore host, then drives the browser over the session's automation
    // WebSocket on the same host. A route permits no WebSocket, and build adds no permit for one,
    // so the user writes it in a policy of the local profile, as this test does.
    test.concurrent(
      "a Browser connection opens a browser that the boxed agent drives",
      { timeout: DEPLOY_TEST_TIMEOUT },
      async () => {
        const projectDir = await createTemplateProject(cli, strands, { deploys: true });
        await addConnection(projectDir, "browser");
        await allowBrowserWebSocket(projectDir);
        await writeFile(join(projectDir, "app", CREATED_RUNTIME_NAME, "main.py"), BROWSER_AGENT);
        await deployed(cli, projectDir, async () => {
          await askAgent<{ product?: string; error?: string }>(
            cli,
            projectDir,
            getSessionId("box-browser"),
            "run",
            (reply) => expect(reply.product).toMatch(/Chrom/i),
          );
          await assertRunsInBox(cli, projectDir);
        });
      },
    );

    // The template's agent keeps the conversation in Memory: short-term events within a session,
    // and facts that long-term extraction makes available to a new session of the same actor.
    test.concurrent(
      "Memory recalls a fact within a session and from a new session",
      { timeout: DEPLOY_TEST_TIMEOUT + 10 * 60 * 1000 },
      async () => {
        const projectDir = await createTemplateProject(cli, strands, { deploys: true });
        const color = `teal${Date.now().toString(36).slice(-4)}`;
        await deployed(cli, projectDir, async () => {
          const first = getSessionId("box-mem-a");
          await ask(
            cli,
            projectDir,
            CREATED_RUNTIME_NAME,
            first,
            `My favorite color is ${color}. Remember it.`,
          );
          expect(
            await ask(cli, projectDir, CREATED_RUNTIME_NAME, first, "What is my favorite color?"),
          ).toMatch(new RegExp(color, "i"));
          // Extraction into long-term memory takes a few minutes.
          await retry(
            async () => {
              const reply = await ask(
                cli,
                projectDir,
                CREATED_RUNTIME_NAME,
                getSessionId("box-mem-b"),
                "What is my favorite color?",
              );
              expect(reply).toMatch(new RegExp(color, "i"));
            },
            10 * 60 * 1000,
            60 * 1000,
          );
        });
      },
    );
  },
);
