import { test, expect, describe, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  tick,
  waitFor,
} from "../../../testing";
import { renderTuiAt } from "../../../tui";
import { createRootHandler } from "../../index";
import { ValueContext } from "../../../router";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { resolveRuntimeTemplateShortcut } from "../shortcuts";
import type { CreateProjectInput } from "../types";

afterEach(cleanupScreens);

// The wizard scaffolds into process.cwd() exactly like the flag-driven path,
// so creation tests run inside a temp directory (same pattern as
// project.test.ts / manager.test.ts).
const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-create-wizard-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// spyOnCreate records every CreateProjectInput handed to the manager while
// still running the real FsProjectManager underneath, so a test can assert
// both the exact input and the files it produced.
function spyOnCreate(core: TestCoreClient): CreateProjectInput[] {
  const inputs: CreateProjectInput[] = [];
  const manager = core.projectManager;
  const original = manager.create.bind(manager);
  manager.create = (input) => {
    inputs.push(input);
    return original(input);
  };
  return inputs;
}

const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6";

describe("project create wizard", () => {
  test("harness default flow: name → type → model → review → created", async () => {
    const directory = await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");

    // Type step: harness is the preselected default.
    await waitForText(r.lastFrame, "what should the project be built around?");
    expect(r.lastFrame()).toContain("● harness (recommended)");
    await r.press("return");

    // Model step: prefilled with the default harness model.
    await waitForText(r.lastFrame, "model id");
    expect(r.lastFrame()).toContain(DEFAULT_MODEL_ID);
    await r.press("return");

    // Review: the summary names the project, type, model, and directory.
    await waitForText(r.lastFrame, "this project will be created");
    const review = r.lastFrame()!;
    expect(review).toContain("DemoApp");
    expect(review).toContain("harness");
    expect(review).toContain(DEFAULT_MODEL_ID);
    expect(review).toContain("./DemoApp");
    await r.press("return");

    // Success: next steps point at the new directory and deploy.
    await waitForText(r.lastFrame, "project created in ./DemoApp", 5000);
    expect(r.lastFrame()).toContain("cd DemoApp");
    expect(r.lastFrame()).toContain("agentcore project deploy");

    // The manager received exactly the input the flag-driven handler builds
    // for `project create --name DemoApp`.
    expect(inputs).toEqual([
      {
        name: "DemoApp",
        skipInstall: false,
        skipGit: false,
        scaffoldHarnessInput: {
          name: "DemoApp",
          model: { provider: "bedrock", modelId: DEFAULT_MODEL_ID },
        },
      },
    ]);

    // ... and really created the project in the cwd.
    const spec = await Bun.file(join(directory, "DemoApp", "agentcore", "agentcore.json")).json();
    expect(spec.harnesses).toEqual([{ name: "DemoApp", path: "app/DemoApp" }]);
    expect(spec.runtimes).toEqual([]);
    r.unmount();
  }, 10000);

  test("an edited model id flows into the harness input", async () => {
    await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("TunedApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("return");

    // The cursor starts at the end of the prefilled id; typing appends.
    await waitForText(r.lastFrame, "model id");
    await r.write("-test");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");
    await waitForText(r.lastFrame, "project created in ./TunedApp", 5000);

    expect(inputs[0]).toEqual({
      name: "TunedApp",
      skipInstall: false,
      skipGit: false,
      scaffoldHarnessInput: {
        name: "TunedApp",
        model: { provider: "bedrock", modelId: `${DEFAULT_MODEL_ID}-test` },
      },
    });
    r.unmount();
  }, 10000);

  test("template flow: strands with the default memory choice", async () => {
    const directory = await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("StrandsApp");
    await r.press("return");

    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("down"); // scaffolded agent code
    await waitForText(r.lastFrame, "● scaffolded agent code");
    await r.press("return");

    // Template step: the three refactor-supported templates are offered.
    await waitForText(r.lastFrame, "choose a template");
    expect(r.lastFrame()).toContain("hello-world-python");
    expect(r.lastFrame()).toContain("hello-world-python-container");
    expect(r.lastFrame()).toContain("● strands-python (recommended)");
    await r.press("return");

    // Memory step: asked only for strands; long and short-term preselected.
    await waitForText(r.lastFrame, "choose a memory configuration");
    expect(r.lastFrame()).toContain("● long and short-term");
    await r.press("return");

    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).toContain("strands-python");
    expect(r.lastFrame()).toContain("longAndShortTerm");
    await r.press("return");
    await waitForText(r.lastFrame, "project created in ./StrandsApp", 5000);

    // Identical to the flag-driven `--template strands-python` input.
    expect(inputs).toEqual([
      {
        name: "StrandsApp",
        skipInstall: false,
        skipGit: false,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("strands-python"),
      },
    ]);

    const spec = await Bun.file(
      join(directory, "StrandsApp", "agentcore", "agentcore.json"),
    ).json();
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toEqual([
      "strands_agent",
    ]);
    expect(spec.memories).toHaveLength(1);
    r.unmount();
  }, 10000);

  test("template flow: choosing no memory overrides the strands default", async () => {
    await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("BareStrands");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a template");
    await r.press("return"); // strands-python is preselected
    await waitForText(r.lastFrame, "choose a memory configuration");
    await r.press("up"); // short-term
    await r.press("up"); // none
    await waitForText(r.lastFrame, "● none");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");
    await waitForText(r.lastFrame, "project created in ./BareStrands", 5000);

    expect(inputs[0]).toEqual({
      name: "BareStrands",
      skipInstall: false,
      skipGit: false,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("strands-python", { memory: "none" }),
    });
    r.unmount();
  }, 10000);

  test("template flow: hello-world skips the memory question", async () => {
    await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("HelloApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a template");
    await r.press("up"); // hello-world-python-container
    await r.press("up"); // hello-world-python
    await waitForText(r.lastFrame, "● hello-world-python ");
    await r.press("return");

    // Straight to review: hello-world does not support memory.
    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).not.toContain("memory");
    await r.press("return");
    await waitForText(r.lastFrame, "project created in ./HelloApp", 5000);

    expect(inputs[0]).toEqual({
      name: "HelloApp",
      skipInstall: false,
      skipGit: false,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("hello-world-python"),
    });
    r.unmount();
  }, 10000);

  test("the name step shows the schema's messages and blocks continuing", async () => {
    const r = renderScreen("/agentcore/project/create");

    await waitForText(r.lastFrame, "name your project");
    // Submitting an empty name surfaces the schema's required message.
    await r.press("return");
    await waitForText(r.lastFrame, "Project name is required");

    // A name that starts with a digit shows the pattern message live.
    await r.write("1abc");
    await waitForText(r.lastFrame, "must start with a letter");
    await r.press("return");
    // Still on the name step.
    expect(r.lastFrame()).toContain("name your project");
    r.unmount();
  });

  test("a reserved name is rejected with the schema's message", async () => {
    const r = renderScreen("/agentcore/project/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("bedrock");
    await waitForText(r.lastFrame, "conflicts with a reserved package dependency");
    await r.press("return");
    expect(r.lastFrame()).toContain("name your project");
    r.unmount();
  });

  test("a pasted chunk with a trailing return keeps the name clean", async () => {
    const r = renderScreen("/agentcore/project/create");

    await waitForText(r.lastFrame, "name your project");
    // A terminal paste (or keystrokes coalesced under load) arrives as one
    // stdin chunk whose key.return is false even though it ends in "\r". The
    // control byte must be stripped, not stored as an invisible character
    // that fails validation with a message the user can't act on.
    await r.write("PasteName\r");
    await waitForText(r.lastFrame, "PasteName");
    expect(r.lastFrame()).not.toContain("must start with a letter");

    // The embedded "\r" is not a submit; a real enter advances with the
    // clean value — which it could not do if the control byte had stuck.
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    r.unmount();
  });

  test("esc steps back through the flow and leaves from the first step", async () => {
    const r = renderScreen("/agentcore/project/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("escape");
    await waitForText(r.lastFrame, "name your project");
    // Esc on the first step lands on the project menu.
    await r.press("escape");
    await waitForText(r.lastFrame, "manage an AgentCore project");
    r.unmount();
  });

  test("selecting create from the project menu opens the wizard", async () => {
    const r = renderScreen("/agentcore/project");

    // `create` is the first menu item, so it is already selected.
    await waitForText(r.lastFrame, "❯ create");
    await r.press("return");
    await waitForText(r.lastFrame, "name your project");
    r.unmount();
  });

  test("an error from create() renders after the streamed progress", async () => {
    const core = new TestCoreClient();
    core.projectManager.create = () => {
      return (async function* () {
        yield { message: "creating project directory" };
        throw new Error("disk full");
      })();
    };
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("return");
    await waitForText(r.lastFrame, "model id");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");

    // The error panel also requests app exit, which may unmount the screen;
    // assert on the frame history rather than only the final frame.
    await waitFor(() =>
      r.frames.some(
        (frame) => frame.includes("✗ disk full") && frame.includes("creating project directory"),
      ),
    );
    r.unmount();
  });

  test("a create() error tears the TUI down nonzero (renderTuiAt rejects)", async () => {
    const core = new TestCoreClient();
    const created: CreateProjectInput[] = [];
    core.projectManager.create = (input) => {
      created.push(input);
      return (async function* () {
        yield { message: "creating project directory" };
        throw new Error("disk full");
      })();
    };
    const { streams, stdin } = ttyTestIO();

    // The settlement handler is attached before any input is sent: the app
    // exits (rejecting waitUntilExit) while keys are still being paced, and a
    // bare rejected promise would trip bun's unhandled-rejection detection.
    const caught: Promise<unknown> = renderTuiAt(
      "/agentcore/project/create",
      ValueContext.EmptyContext(),
      core,
      streams.io,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Walk the shortest path (harness defaults) by raw key writes — frames are
    // not observable here (Ink suppresses incremental frames under CI), so the
    // pacing is tick-based. Writes are spaced out so consecutive keys cannot
    // coalesce into one stdin chunk (Ink parses a merged "\r\r" as text, not as
    // return presses); a slow trailing pump re-sends return as a recovery for a
    // key that landed before its step's input handler subscribed.
    await tick(50);
    stdin.write("DemoApp");
    // One return per step: name → type → model → review → submit.
    for (let press = 0; press < 4; press++) {
      await tick(50);
      stdin.write("\r");
    }
    await waitFor(
      () => {
        if (created.length === 0) stdin.write("\r");
        return created.length > 0;
      },
      5000,
      150,
    );

    // exit(error) rejects waitUntilExit, so the error takes the normal CLI
    // path and the process exits nonzero.
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("disk full");
  }, 10000);
});

describe("project create dispatch", () => {
  function buildRoot(io: AppIO, core = new TestCoreClient()) {
    return createRootHandler(core, {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  test("bare create in a TTY session opens the wizard", async () => {
    await inTempDirectory(); // hygiene: nothing must be created outside a temp dir
    const { streams, stdin } = ttyTestIO();
    const root = buildRoot(streams.io);

    // outcome never rejects, so a mid-pump failure cannot trip bun's
    // unhandled-rejection detection before the final assertion.
    const outcome = root.route(["node", "agentcore", "project", "create"]).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The wizard never finishes on its own; Ctrl+C (re-sent until the app
    // reacts, slowly enough that repeats cannot coalesce into one chunk)
    // closes it and resolves the route cleanly. The headless branch would
    // instead reject with the missing --name usage error.
    await waitFor(
      () => {
        if (!settled) stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(streams.stderr()).not.toContain("required option");
  }, 10000);

  test("bare create without a TTY stays headless and reports the missing --name", async () => {
    const io = testIO();
    const root = buildRoot(io.io);

    const error: unknown = await root
      .route(["node", "agentcore", "project", "create"])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name <name>' not specified");
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    const { streams } = ttyTestIO();
    const root = buildRoot(streams.io);

    const error: unknown = await root
      .route(["node", "agentcore", "project", "create", "--defaults"])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name <name>' not specified");
  });

  test("--json stays headless even in a TTY", async () => {
    const { streams } = ttyTestIO();
    const root = buildRoot(streams.io);

    const error: unknown = await root
      .route(["node", "agentcore", "project", "create", "--json"])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name <name>' not specified");
  });

  test("flag-driven create still runs headless in a TTY session", async () => {
    const directory = await inTempDirectory();
    const { streams } = ttyTestIO();
    const root = buildRoot(streams.io);

    await root.route([
      "node",
      "agentcore",
      "project",
      "create",
      "--name",
      "FlagApp",
      "--skip-install",
      "--skip-git",
    ]);

    expect(existsSync(join(directory, "FlagApp", "agentcore", "agentcore.json"))).toBe(true);
    expect(streams.stderr()).toContain("Created project 'FlagApp'");
  }, 10000);
});
