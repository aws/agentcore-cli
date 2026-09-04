import { test, expect, describe, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
  waitFor,
} from "../../../testing";
import { createRootHandler } from "../../index";
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

    // Model step: providers and the selected provider's fields share one page.
    await waitForText(r.lastFrame, "choose a model");
    expect(r.lastFrame()).toContain("● bedrock (recommended)");
    expect(r.lastFrame()).toContain("○ openai");
    expect(r.lastFrame()).toContain("○ gemini");
    expect(r.lastFrame()).toContain("○ litellm");
    expect(r.lastFrame()).toContain(DEFAULT_MODEL_ID);
    await r.press("return"); // focus model id
    await r.press("return"); // accept model id

    // Review: the summary names the project, type, model, and directory.
    await waitForText(r.lastFrame, "this project will be created");
    const review = r.lastFrame()!;
    expect(review).toContain("DemoApp");
    expect(review).toContain("harness");
    expect(review).toContain(DEFAULT_MODEL_ID);
    expect(review).toContain("./DemoApp");
    await r.press("return");

    // Success: next steps point at the new directory and deploy.
    await waitForText(r.lastFrame, "✔ project created in ./DemoApp", 5000);
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

    // Enter focuses the selected provider's model field. The cursor starts at
    // the end of the prefilled id, so typing appends.
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return");
    await r.write("-test");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./TunedApp", 5000);

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

  test("a provider API key ARN flows through the existing harness input", async () => {
    const directory = await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });
    const apiKeyArn =
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/OpenAIKey";

    await waitForText(r.lastFrame, "name your project");
    await r.write("OpenAIApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a model");
    await r.press("down");
    expect(r.lastFrame()).toContain("● openai");
    await r.press("return"); // focus model id
    expect(r.lastFrame()).toContain("gpt-5");
    await r.press("return"); // focus API key ARN
    await r.press("return");
    await waitForText(r.lastFrame, "enter an API key ARN for openai");
    await r.write(apiKeyArn);
    await r.press("return");

    await waitForText(r.lastFrame, "this project will be created");
    const review = r.lastFrame()!;
    expect(review).toContain("provider");
    expect(review).toContain("openai");
    expect(review).toContain("model");
    expect(review).toContain("gpt-5");
    expect(review).toContain("API key ARN");
    expect(review.replace(/\s/g, "")).toContain(apiKeyArn);
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./OpenAIApp", 5000);

    expect(inputs[0]).toEqual({
      name: "OpenAIApp",
      skipInstall: false,
      skipGit: false,
      scaffoldHarnessInput: {
        name: "OpenAIApp",
        model: {
          provider: "open_ai",
          modelId: "gpt-5",
          apiKeyArn,
        },
      },
    });

    const root = join(directory, "OpenAIApp");
    const spec = await Bun.file(join(root, "agentcore", "agentcore.json")).json();
    expect(spec.credentials).toEqual([]);
    const harness = await Bun.file(join(root, "app", "OpenAIApp", "harness.json")).json();
    expect(harness.model).toEqual({
      provider: "open_ai",
      modelId: "gpt-5",
      apiKeyArn,
    });
    r.unmount();
  }, 10000);

  test("switching providers preserves each provider's model input", async () => {
    const r = renderScreen("/agentcore/project/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("ProviderApp");
    await r.press("return");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");

    await r.press("down"); // openai
    await r.press("return"); // model id
    await r.write("-custom");
    await r.press("escape"); // provider list
    await r.press("down"); // gemini
    expect(r.lastFrame()).toContain("● gemini");
    await r.press("up"); // openai
    await r.press("return");
    expect(r.lastFrame()).toContain("gpt-5-custom");
    r.unmount();
  });

  test("the model picker remains readable in an 80x24 terminal", async () => {
    const r = renderScreen("/agentcore/project/create");
    await r.resize(80, 24);

    await waitForText(r.lastFrame, "name your project");
    await r.write("CompactApp");
    await r.press("return");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");

    const frame = r.lastFrame()!;
    const lines = frame.split("\n");
    expect(lines[0]).toContain("agentcore → project → create");
    expect(lines[1]).toBe("─".repeat(80));
    expect(lines[2]).toContain("✓ name");
    expect(frame).toContain("● bedrock (recommended)");
    expect(frame).toContain("○ openai");
    expect(frame).toContain("○ gemini");
    expect(frame).toContain("○ litellm");
    expect(frame).toContain("model ID");
    expect(frame).toContain(DEFAULT_MODEL_ID);
    expect(frame).toContain("[enter] continue");
    expect(frame).toContain("[esc] back");
    r.unmount();
  });

  test("template flow: strands goes straight to review (no memory question)", async () => {
    const directory = await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("StrandsApp");
    await r.press("return");

    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("down"); // agent code
    await waitForText(r.lastFrame, "● agent code");
    await r.press("return");

    // Template step: the supported templates are offered, including the
    // -container variants and the empty project.
    await waitForText(r.lastFrame, "choose a template");
    expect(r.lastFrame()).toContain("● agent-python-strands (recommended)");
    expect(r.lastFrame()).toContain("agent-python-strands-container");
    await r.press("return");

    // No memory step: memory is no longer a choice, so review follows directly.
    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).not.toContain("choose a memory configuration");
    expect(r.lastFrame()).toContain("agent-python-strands");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./StrandsApp", 5000);

    // Identical to the flag-driven `--template agent-python-strands` input.
    expect(inputs).toEqual([
      {
        name: "StrandsApp",
        skipInstall: false,
        skipGit: false,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands"),
      },
    ]);

    const spec = await Bun.file(
      join(directory, "StrandsApp", "agentcore", "agentcore.json"),
    ).json();
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toEqual([
      "agent_python_strands",
    ]);
    // The strands template ships with longAndShortTerm memory pre-configured.
    expect(spec.memories).toHaveLength(1);
    r.unmount();
  }, 10000);

  test("template flow: the minimal template scaffolds without memory", async () => {
    const directory = await inTempDirectory();
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
    await r.press("down"); // agent-python-strands-container
    await r.press("down"); // agent-python-minimal
    await waitForText(r.lastFrame, "● agent-python-minimal ");
    await r.press("return");

    // Straight to review.
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./HelloApp", 5000);

    expect(inputs[0]).toEqual({
      name: "HelloApp",
      skipInstall: false,
      skipGit: false,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-minimal"),
    });

    const spec = await Bun.file(join(directory, "HelloApp", "agentcore", "agentcore.json")).json();
    expect(spec.memories ?? []).toHaveLength(0);
    r.unmount();
  }, 10000);

  test("template flow: the empty template creates a project with no runtime", async () => {
    const directory = await inTempDirectory();
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("EmptyApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a template");
    // empty is the last option in the list.
    for (let i = 0; i < 10; i++) await r.press("down");
    await waitForText(r.lastFrame, "● empty");
    await r.press("return");

    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");
    await waitForText(r.lastFrame, "project created in ./EmptyApp", 5000);

    expect(inputs[0]).toEqual({ name: "EmptyApp", skipInstall: false, skipGit: false });

    const spec = await Bun.file(join(directory, "EmptyApp", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes ?? []).toHaveLength(0);
    expect(spec.harnesses ?? []).toHaveLength(0);
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

  test("streamed progress renders as the CLI's step list", async () => {
    const core = new TestCoreClient();
    let releaseFirstStep!: () => void;
    const beforeFirstStep = new Promise<void>((resolve) => {
      releaseFirstStep = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    core.projectManager.create = () => {
      return (async function* () {
        await beforeFirstStep;
        yield { type: "step", message: "syncing dependencies" };
        await held;
        throw new Error("stopped");
      })();
    };
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");

    await waitForText(r.lastFrame, "creating DemoApp…");
    releaseFirstStep();

    // The running step is the spinner row itself, as on the command line; the
    // generic "creating…" spinner shows only until the first step arrives.
    await waitForText(r.lastFrame, "syncing dependencies");
    expect(r.lastFrame()).not.toContain("creating DemoApp…");
    expect(r.lastFrame()).not.toContain("✓ syncing dependencies");

    r.unmount();
    release();
  });

  test("a create() error offers r to retry only before anything was written, esc returns to review with the input kept", async () => {
    await inTempDirectory();
    const core = new TestCoreClient();
    const created: CreateProjectInput[] = [];
    const real = core.projectManager.create.bind(core.projectManager);
    core.projectManager.create = (input) => {
      created.push(input);
      if (created.length > 2) return real(input);
      // First attempt fails before any step (a missing tool), the second after
      // the tree was written.
      const wroteTree = created.length === 2;
      return (async function* () {
        if (wroteTree) yield { type: "step" as const, message: "creating project directory" };
        throw new Error("'git' was not found on your PATH.");
      })();
    };
    const r = renderScreen("/agentcore/project/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return"); // focus model id
    await r.press("return"); // accept model id
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");

    await waitForText(r.lastFrame, "✗ 'git' was not found on your PATH.");
    expect(r.lastFrame()).toContain("[r] retry");
    expect(r.lastFrame()).toContain("[esc] back");

    await r.write("r");
    await waitFor(() => created.length === 2);
    await waitForText(r.lastFrame, "creating project directory");
    await waitForText(r.lastFrame, "✗ 'git' was not found on your PATH.");
    expect(r.lastFrame()).not.toContain("[r] retry");
    expect(r.lastFrame()).toContain("[esc] back");

    await r.press("escape");
    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).toContain("DemoApp");

    await r.press("return");
    await waitForText(r.lastFrame, "project created in ./DemoApp");
    expect(created).toHaveLength(3);
    expect(created[2]).toEqual(created[0]);
    r.unmount();
  });

  test("on Windows a deep project root is refused before anything is written", async () => {
    const deep = join(await inTempDirectory(), "n".repeat(120));
    await mkdir(deep);
    process.chdir(deep);
    const r = renderScreen("/agentcore/project/create", { platform: "win32" });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the project be built around?");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");

    await waitForText(r.lastFrame, "too long for Windows");
    expect(r.lastFrame()).toContain("Create the project in a shorter directory.");
    expect(r.lastFrame()).not.toContain("--skip-install");
    expect(r.lastFrame()).toContain("[r] retry");
    expect(await readdir(deep)).toEqual([]);
    r.unmount();
  });
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
      .route(["node", "agentcore", "project", "create", "--skip-git"])
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
