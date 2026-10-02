import { test, expect, describe, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  renderScreen,
  waitForText,
  flatFrame,
  cleanupScreens,
  createSilentLogger,
  inTempDirectory,
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
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { RegionKey } from "../../keys";
import { DEFAULT_MODEL_IDS } from "../../../projectSchemas/runtime";
import { MODEL_PROVIDER_RUNTIMES_CN_MESSAGE } from "../../../core/project/manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(cleanupScreens);

// The wizard scaffolds into process.cwd() exactly like the flag-driven path,
// so creation tests run inside a temp directory (same pattern as
// project.test.ts / manager.test.ts).
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

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

const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-5";
const STRANDS_BEDROCK_MODEL_ID = DEFAULT_MODEL_IDS.Bedrock;

describe("project create wizard", () => {
  test("harness flow: name → type → model provider → review → created", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");

    // Type step: code-based is the preselected default.
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    const typeStep = r.lastFrame()!;
    expect(typeStep).toContain("● code-based");
    expect(typeStep).toContain("○ config-based");
    expect(typeStep).not.toContain("config-based (recommended)");
    expect(typeStep.indexOf("● code-based")).toBeLessThan(typeStep.indexOf("○ config-based"));
    await r.press("down"); // harness
    await r.press("return");

    // Model step: fields stay hidden until the provider is confirmed.
    await waitForText(r.lastFrame, "choose a model provider");
    expect(r.lastFrame()).toContain("● model provider ──");
    expect(r.lastFrame()).toContain("● bedrock");
    expect(r.lastFrame()).not.toContain("bedrock (recommended)");
    expect(r.lastFrame()).toContain("○ openai");
    expect(r.lastFrame()).toContain("○ gemini");
    expect(r.lastFrame()).toContain("○ litellm");
    expect(r.lastFrame()).not.toContain(DEFAULT_MODEL_ID);
    await r.press("return"); // focus model id
    await waitForText(r.lastFrame, DEFAULT_MODEL_ID);
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
    expect(r.lastFrame()).toContain("agentcore deploy");

    // The manager received exactly the input the flag-driven handler builds
    // for `agentcore create --name DemoApp`.
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
    cleanups.push((await inTempDirectory()).cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("TunedApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("down"); // harness
    await r.press("return");

    // Enter focuses the selected provider's model field. The cursor starts at
    // the end of the prefilled id, so typing appends.
    await waitForText(r.lastFrame, "choose a model provider");
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
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });
    const apiKeyArn =
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/OpenAIKey";

    await waitForText(r.lastFrame, "name your project");
    await r.write("OpenAIApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("down"); // harness
    await r.press("return");

    await waitForText(r.lastFrame, "choose a model provider");
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
    const harness = parse(await Bun.file(join(root, "app", "OpenAIApp", "harness.yaml")).text());
    expect(harness.model).toEqual({
      openAiModelConfig: { modelId: "gpt-5", apiKeyArn },
    });
    expect(harness.memory).toEqual({ managedMemoryConfiguration: {} });
    expect(harness.systemPrompt).toBeUndefined();
    r.unmount();
  }, 10000);

  test("switching providers preserves each provider's model input", async () => {
    const r = renderScreen("/agentcore/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("ProviderApp");
    await r.press("return");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");

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

  test("reveals model fields only after enter and hides them again on escape", async () => {
    const r = renderScreen("/agentcore/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("ModelApp");
    await r.press("return");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");

    await r.press("down"); // openai
    await waitForText(r.lastFrame, "● openai");
    expect(r.lastFrame()).not.toContain("model ID");
    expect(r.lastFrame()).not.toContain("API key ARN");

    await r.press("return");
    await waitForText(r.lastFrame, "model ID");
    expect(r.lastFrame()).toContain("API key ARN");

    await r.press("escape");
    await waitFor(() => !(r.lastFrame() ?? "").includes("model ID"));
    expect(r.lastFrame()).not.toContain("API key ARN");
    expect(r.lastFrame()).toContain("● openai");
    r.unmount();
  });

  test("the model picker remains readable in an 80x24 terminal", async () => {
    const r = renderScreen("/agentcore/create");
    await r.resize(80, 24);

    await waitForText(r.lastFrame, "name your project");
    await r.write("CompactApp");
    await r.press("return");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");

    const frame = r.lastFrame()!;
    const lines = frame.split("\n");
    expect(lines[0]).toContain("agentcore → create");
    expect(lines[1]).toBe("─".repeat(80));
    expect(lines[2]).toContain("✓ name");
    expect(frame).toContain("● bedrock");
    expect(frame).not.toContain("bedrock (recommended)");
    expect(frame).toContain("○ openai");
    expect(frame).toContain("○ gemini");
    expect(frame).toContain("○ litellm");
    expect(frame).not.toContain("model ID");
    expect(frame).not.toContain(DEFAULT_MODEL_ID);
    expect(frame).toContain("[enter] continue");
    expect(frame).toContain("[esc] back");
    r.unmount();
  });

  test("the litellm fields stay inside the model step in an 80x24 terminal", async () => {
    const r = renderScreen("/agentcore/create");
    await r.resize(80, 24);

    await waitForText(r.lastFrame, "name your project");
    await r.write("CompactApp");
    await r.press("return");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
    await r.press("down");
    await r.press("down");
    await r.press("down"); // litellm
    await r.press("return");
    await waitForText(r.lastFrame, "the litellm model to use");

    const lines = r.lastFrame()!.split("\n");
    expect(lines).toHaveLength(24);
    expect(lines[0]).toContain("agentcore → create");
    expect(lines).toContain(" choose a model provider");
    expect(lines).toContain(" model ID");
    expect(lines).toContain(" API key ARN");
    expect(lines.at(-2)).toBe("─".repeat(80));
    expect(lines.at(-1)).toContain("[enter] continue");
    r.unmount();
  });

  test("the model step scrolls only to reveal a field that is out of view", async () => {
    const r = renderScreen("/agentcore/create");
    await r.resize(80, 24);

    await waitForText(r.lastFrame, "name your project");
    await r.write("CompactApp");
    await r.press("return");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
    await r.press("down");
    await r.press("down");
    await r.press("down"); // litellm
    const settledLines = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return r.lastFrame()!.split("\n");
    };
    const firstContentLine = 4;

    // Model ID and API key ARN are already visible, so the view stays put.
    await r.press("return");
    await waitForText(r.lastFrame, "the litellm model to use");
    expect((await settledLines())[firstContentLine]).toBe(" choose a model provider");
    await r.press("down");
    expect((await settledLines())[firstContentLine]).toBe(" choose a model provider");

    // API base URL is below the fold: scroll just far enough to show it.
    await r.press("down");
    await waitForText(r.lastFrame, "https://…");
    const scrolled = await settledLines();
    expect(scrolled[firstContentLine]).not.toBe(" choose a model provider");
    expect(scrolled).toContain(" model ID");
    expect(scrolled).toContain(" API base URL");

    // Moving back up to fields that are still visible does not shift the view.
    await r.press("up");
    expect((await settledLines())[firstContentLine]).toBe(scrolled[firstContentLine]);
    await r.press("up");
    expect((await settledLines())[firstContentLine]).toBe(scrolled[firstContentLine]);

    // Returning to the provider list shows it from the top again.
    await r.press("up");
    await waitFor(
      () => r.lastFrame()!.split("\n")[firstContentLine] === " choose a model provider",
    );
    expect(r.lastFrame()).not.toContain("model ID");
    r.unmount();
  });

  test("template flow: strands asks the model provider, then review (no memory question)", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("StrandsApp");
    await r.press("return");

    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await waitForText(r.lastFrame, "● code-based");
    await r.press("return");

    // Template step: the supported templates are offered, including the
    // -container variants and the empty project.
    await waitForText(r.lastFrame, "choose a template");
    expect(r.lastFrame()).toContain("● agent-python-strands");
    expect(r.lastFrame()).not.toContain("agent-python-strands (recommended)");
    expect(r.lastFrame()).toContain("agent-python-strands-container");
    expect(r.lastFrame()).toContain("environment-python-bma");
    await r.press("return");

    // Model step: strands takes a model-provider override, so the wizard asks
    // the same question the --model-provider/--model-id/--api-key flags
    // answer. Bedrock is preselected with the template's default model id;
    // fields stay hidden until the provider is confirmed.
    await waitForText(r.lastFrame, "choose a model provider");
    expect(r.lastFrame()).toContain("● model provider ──");
    expect(r.lastFrame()).toContain("● bedrock");
    expect(r.lastFrame()).toContain("○ anthropic");
    expect(r.lastFrame()).toContain("○ openai");
    expect(r.lastFrame()).toContain("○ gemini");
    expect(r.lastFrame()).toContain("○ litellm");
    expect(r.lastFrame()).not.toContain("not accessible from China regions");
    expect(r.lastFrame()).not.toContain(STRANDS_BEDROCK_MODEL_ID);
    await r.press("return"); // focus model id
    await waitForText(r.lastFrame, STRANDS_BEDROCK_MODEL_ID);
    // Bedrock uses the runtime's IAM role, so no API key is asked for.
    expect(r.lastFrame()).not.toContain("API key file");
    await r.press("return"); // accept model id

    // No memory step: memory is no longer a choice, so review follows directly.
    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).not.toContain("choose a memory configuration");
    expect(r.lastFrame()).toContain("agent-python-strands");
    expect(flatFrame(r.lastFrame)).toContain("model provider bedrock");
    expect(r.lastFrame()).toContain(STRANDS_BEDROCK_MODEL_ID);
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./StrandsApp", 5000);

    // Identical to the flag-driven `--template agent-python-strands` input:
    // the default model id is not sent as an override.
    expect(inputs).toEqual([
      {
        name: "StrandsApp",
        skipInstall: false,
        skipGit: false,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands", {
          runtimeName: "agent",
        }),
      },
    ]);
    expect(inputs[0]!.scaffoldRuntimeInput!.modelId).toBeUndefined();

    const spec = await Bun.file(
      join(directory, "StrandsApp", "agentcore", "agentcore.json"),
    ).json();
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toEqual(["agent"]);
    // The strands template ships with longAndShortTerm memory pre-configured.
    expect(spec.memories).toHaveLength(1);
    r.unmount();
  }, 10000);

  // walkToStrandsModelStep drives the wizard to the model step of the strands
  // template: name → code-based → agent-python-strands → "choose a model provider".
  async function walkToStrandsModelStep(
    r: ReturnType<typeof renderScreen>,
    name: string,
  ): Promise<void> {
    await waitForText(r.lastFrame, "name your project");
    await r.write(name);
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("return");
    await waitForText(r.lastFrame, "● agent-python-strands ");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
  }

  test("the model step's keys: esc leaves the list, arrows move between fields, enter returns to a missing one", async () => {
    cleanups.push((await inTempDirectory()).cleanup);
    const r = renderScreen("/agentcore/create");
    await walkToStrandsModelStep(r, "KeysApp");

    // esc on the provider list steps back to the template.
    await r.press("escape");
    await waitForText(r.lastFrame, "choose a template");
    expect(r.lastFrame()).not.toContain("choose a model provider");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");

    await r.press("down"); // anthropic
    await waitForText(r.lastFrame, "● anthropic");
    await r.press("return"); // focus the model id
    await waitForText(r.lastFrame, DEFAULT_MODEL_IDS.Anthropic);
    // Clear the prefilled id, then move on with the arrow — arrows do not validate.
    for (let i = 0; i < DEFAULT_MODEL_IDS.Anthropic.length; i++) await r.press("backspace");
    await r.press("down"); // API key file
    await waitForText(r.lastFrame, "API key file");
    await r.press("up"); // back to the model id, no error raised by moving
    await r.press("down");
    expect(r.lastFrame()).not.toContain("enter a model ID for anthropic");
    await r.write("file:///tmp/anthropic.key");
    // enter on the last field is valid here, but the earlier field is empty:
    // focus returns to it with its own message instead of continuing.
    await r.press("return");
    await waitForText(r.lastFrame, "enter a model ID for anthropic");
    expect(r.lastFrame()).not.toContain("this project will be created");
    r.unmount();
  });

  test("a key path wider than the terminal wraps without looping the model step", async () => {
    // A wrapped input line grows the field; the scroll-into-view callback and
    // the viewport re-measure then fed each other until React gave up
    // ("Maximum update depth exceeded") and the frame went blank. CI hit it
    // through long macOS/Windows temp paths; a long path pins it here.
    cleanups.push((await inTempDirectory()).cleanup);
    const r = renderScreen("/agentcore/create"); // 100 columns
    await walkToStrandsModelStep(r, "WideKey");
    await r.press("down"); // anthropic
    await waitForText(r.lastFrame, "● anthropic");
    await r.press("return");
    await r.press("return"); // default model id → API key file
    await waitForText(r.lastFrame, "API key file");
    const widePath = `file:///tmp/${"x".repeat(150)}/anthropic.key`; // wraps onto a second row
    await r.write(widePath);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const frame = r.lastFrame() ?? "";
    expect(frame).not.toContain("Maximum update depth");
    expect(frame).toContain("API key file");
    expect(frame.replace(/\s/g, "")).toContain("anthropic.key");
    r.unmount();
  });

  test("an API-key provider reads the key from its file:// source, exactly like the flags", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const keyFile = join(directory, "anthropic.key");
    await writeFile(keyFile, "sk-ant-test-key\n");
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await walkToStrandsModelStep(r, "KeyedApp");
    await r.press("down"); // anthropic
    await waitForText(r.lastFrame, "● anthropic");
    await r.press("return"); // focus model id (prefilled with Anthropic's default)
    await waitForText(r.lastFrame, DEFAULT_MODEL_IDS.Anthropic);
    await r.press("return"); // accept it → API key file
    await waitForText(r.lastFrame, "API key file");
    expect(r.lastFrame()).not.toContain("optional");
    await r.write(`file://${keyFile}`);
    await r.press("return");

    await waitForText(r.lastFrame, "this project will be created");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("model provider anthropic");
    // The row may wrap mid-path at the frame width (CI temp paths are long), so
    // compare with all whitespace removed.
    expect(review.replace(/\s/g, "")).toContain(`APIkeyfile://${keyFile}`);
    // The review shows the key's source, never the key.
    expect(review).not.toContain("sk-ant-test-key");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./KeyedApp", 5000);

    // Identical to `--template agent-python-strands --model-provider anthropic
    // --api-key file://…`: the resolver read the file, the default id stays implicit.
    expect(inputs).toEqual([
      {
        name: "KeyedApp",
        skipInstall: false,
        skipGit: false,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands", {
          runtimeName: "agent",
          modelProvider: "Anthropic",
          apiKey: "sk-ant-test-key",
        }),
      },
    ]);
    const spec = await Bun.file(join(directory, "KeyedApp", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0].modelProvider).toBe("Anthropic");
    expect(spec.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "agentAnthropicApiKey" },
    ]);
    const envLocal = await Bun.file(join(directory, "KeyedApp", "agentcore", ".env.local")).text();
    expect(envLocal).toContain("sk-ant-test-key");
    r.unmount();
  }, 10000);

  test("the model step refuses a missing or inline API key before anything is written", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await walkToStrandsModelStep(r, "NoKeyApp");
    await r.press("down"); // anthropic
    await r.press("down"); // openai
    await waitForText(r.lastFrame, "● openai");
    await r.press("return"); // model id
    await r.press("return"); // → API key file (required for OpenAI)
    await waitForText(r.lastFrame, "API key file");
    await r.press("return"); // empty
    await waitForText(r.lastFrame, "enter the API key file for openai");

    // An inline secret is refused the way the --api-key flag refuses it.
    await r.write("sk-inline-secret");
    await r.press("return");
    await waitForText(r.lastFrame, "enter a file:// path to the key");
    expect(r.lastFrame()).not.toContain("this project will be created");

    expect(inputs).toEqual([]);
    expect(existsSync(join(directory, "NoKeyApp"))).toBe(false);
    r.unmount();
  });

  test("switching providers keeps each provider's model id and key source", async () => {
    cleanups.push((await inTempDirectory()).cleanup);
    const r = renderScreen("/agentcore/create", { core: new TestCoreClient() });

    await walkToStrandsModelStep(r, "SwitchApp");
    await r.press("down"); // anthropic
    await r.press("return"); // model id
    await r.write("-edited");
    await r.press("escape"); // back to the provider list, edit kept
    await r.press("down"); // openai
    await r.press("return");
    await waitForText(r.lastFrame, DEFAULT_MODEL_IDS.OpenAI);
    expect(r.lastFrame()).not.toContain("-edited");
    await r.press("escape");
    await r.press("up"); // anthropic again
    await r.press("return");
    await waitForText(r.lastFrame, `${DEFAULT_MODEL_IDS.Anthropic}-edited`);
    r.unmount();
  });

  test("in a China region the model step starts on LiteLLM and flags the blocked providers", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", {
      core,
      withContext: (ctx) => ctx.withValue(RegionKey, "cn-north-1"),
    });

    await walkToStrandsModelStep(r, "CnApp");
    // LiteLLM is the one provider that can pass the China gate, so it is
    // preselected; the others say why they are not.
    expect(r.lastFrame()).toContain("● litellm");
    expect(r.lastFrame()).toContain("○ bedrock");
    expect(flatFrame(r.lastFrame).match(/not accessible from China regions/g)).toHaveLength(4);
    await r.press("return"); // focus model id
    // No Bedrock-routed default is prefilled there; a model id must be given.
    await waitForText(r.lastFrame, "reachable from China regions");
    expect(r.lastFrame()).not.toContain(DEFAULT_MODEL_IDS.LiteLLM);
    await r.press("return");
    await waitForText(r.lastFrame, "enter a model ID for litellm");
    await r.write("deepseek/deepseek-chat");
    await r.press("return"); // → API key file (optional for LiteLLM)
    await waitForText(r.lastFrame, "optional");
    await r.press("return"); // skip it

    await waitForText(r.lastFrame, "this project will be created");
    expect(flatFrame(r.lastFrame)).toContain("model provider litellm");
    expect(r.lastFrame()).toContain("deepseek/deepseek-chat");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./CnApp", 5000);

    // The same input `--template agent-python-strands --model-provider litellm
    // --model-id deepseek/deepseek-chat` produces in a China region, with the
    // default memory dropped and the notice shown as a step.
    const expected = resolveRuntimeTemplateShortcut("agent-python-strands", {
      runtimeName: "agent",
      modelProvider: "LiteLLM",
      modelId: "deepseek/deepseek-chat",
    });
    expected.memory = undefined;
    expect(inputs).toEqual([
      { name: "CnApp", skipInstall: false, skipGit: false, scaffoldRuntimeInput: expected },
    ]);
    expect(r.lastFrame()).toContain("AgentCore Memory is not available in China regions");
    const spec = await Bun.file(join(directory, "CnApp", "agentcore", "agentcore.json")).json();
    expect(spec.memories ?? []).toEqual([]);
    expect(spec.runtimes[0]).toMatchObject({
      modelProvider: "LiteLLM",
      modelId: "deepseek/deepseek-chat",
    });
    r.unmount();
  }, 10000);

  test("in a China region picking Bedrock is refused at submit with retry on offer", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", {
      core,
      withContext: (ctx) => ctx.withValue(RegionKey, "cn-north-1"),
    });

    await walkToStrandsModelStep(r, "CnBedrock");
    for (let i = 0; i < 4; i++) await r.press("up"); // bedrock
    await waitForText(r.lastFrame, "● bedrock");
    await r.press("return");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");

    // The gate the flag path runs rejects it before anything is written; the
    // wizard keeps the form so the provider can be changed.
    await waitForText(r.lastFrame, MODEL_PROVIDER_RUNTIMES_CN_MESSAGE.slice(0, 60));
    expect(r.lastFrame()).toContain("[r] retry");
    expect(inputs).toEqual([]);
    expect(existsSync(join(directory, "CnBedrock"))).toBe(false);
    r.unmount();
  });

  test("openai reveals an optional API base URL that flows as --api-base", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const keyFile = join(directory, "openai.key");
    await writeFile(keyFile, "sk-compatible");
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await walkToStrandsModelStep(r, "BaseApp");
    await r.press("down"); // anthropic
    await r.press("down"); // openai
    await waitForText(r.lastFrame, "● openai");
    await r.press("return"); // model id
    await r.press("return"); // API key file
    await waitForText(r.lastFrame, "API key file");
    await r.write(`file://${keyFile}`);
    await r.press("return"); // → API base URL (optional outside China)
    await waitForText(r.lastFrame, "API base URL");
    expect(r.lastFrame()).toContain("optional");
    await r.write("https://api.deepseek.com/v1");
    await r.press("return");

    await waitForText(r.lastFrame, "this project will be created");
    expect(flatFrame(r.lastFrame)).toContain("API base https://api.deepseek.com/v1");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./BaseApp", 5000);

    expect(inputs).toEqual([
      {
        name: "BaseApp",
        skipInstall: false,
        skipGit: false,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands", {
          runtimeName: "agent",
          modelProvider: "OpenAI",
          apiKey: "sk-compatible",
          apiBase: "https://api.deepseek.com/v1",
        }),
      },
    ]);
    const spec = await Bun.file(join(directory, "BaseApp", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0].modelApiBase).toBe("https://api.deepseek.com/v1");
    r.unmount();
  }, 10000);

  // walkToTypeScriptModelStep drives the wizard to the model step of the
  // TypeScript strands template.
  async function walkToTypeScriptModelStep(
    r: ReturnType<typeof renderScreen>,
    name: string,
  ): Promise<void> {
    await waitForText(r.lastFrame, "name your project");
    await r.write(name);
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a template");
    for (let i = 0; i < 10 && !r.lastFrame()!.includes("● agent-typescript-strands"); i++) {
      await r.press("down");
    }
    await waitForText(r.lastFrame, "● agent-typescript-strands");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
  }

  test("a TypeScript template is not offered LiteLLM", async () => {
    cleanups.push((await inTempDirectory()).cleanup);
    const r = renderScreen("/agentcore/create", { core: new TestCoreClient() });

    await walkToTypeScriptModelStep(r, "TsApp");
    expect(r.lastFrame()).toContain("● bedrock");
    expect(r.lastFrame()).toContain("○ gemini");
    expect(r.lastFrame()).not.toContain("litellm");
    r.unmount();
  });

  test("in a China region a TypeScript template starts on openai and requires the API base", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const keyFile = join(directory, "ds.key");
    await writeFile(keyFile, "sk-ds");
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", {
      core,
      withContext: (ctx) => ctx.withValue(RegionKey, "cn-north-1"),
    });

    await walkToTypeScriptModelStep(r, "CnTs");
    expect(r.lastFrame()).toContain("● openai");
    expect(r.lastFrame()).not.toContain("litellm");
    expect(r.lastFrame()).toContain("set an API base URL");
    await r.press("return"); // model id, empty in China
    await r.write("deepseek-chat");
    await r.press("return"); // API key file
    await r.write(`file://${keyFile}`);
    await r.press("return"); // API base URL, required in China
    await waitForText(r.lastFrame, "API base URL");
    await r.press("return");
    await waitForText(r.lastFrame, "enter the API base URL of an endpoint reachable from China");
    await r.write("https://api.deepseek.com/v1");
    await r.press("return");

    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./CnTs", 5000);

    const expected = resolveRuntimeTemplateShortcut("agent-typescript-strands", {
      runtimeName: "agent",
      modelProvider: "OpenAI",
      modelId: "deepseek-chat",
      apiKey: "sk-ds",
      apiBase: "https://api.deepseek.com/v1",
    });
    expected.memory = undefined;
    expect(inputs).toEqual([
      { name: "CnTs", skipInstall: false, skipGit: false, scaffoldRuntimeInput: expected },
    ]);
    const loadModel = await Bun.file(
      join(directory, "CnTs", "app", "agent", "model", "load.ts"),
    ).text();
    expect(loadModel).toContain('baseURL: "https://api.deepseek.com/v1"');
    r.unmount();
  }, 10000);

  test("the wizard rejects Bedrock Managed Agents in a China region before create", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", {
      core,
      withContext: (ctx) => ctx.withValue(RegionKey, "cn-north-1"),
    });

    await waitForText(r.lastFrame, "name your project");
    await r.write("CnBma");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a template");
    await r.press("down"); // agent-python-strands-container
    await r.press("down"); // agent-python-langchain
    await r.press("down"); // environment-python-bma
    await waitForText(r.lastFrame, "● environment-python-bma");
    await r.press("return");
    await waitForText(r.lastFrame, "this project will be created");
    await r.press("return");

    await waitForText(r.lastFrame, "Bedrock Managed Agents is not available in China regions");
    expect(inputs).toEqual([]);
    expect(existsSync(join(directory, "CnBma"))).toBe(false);
    r.unmount();
  });

  test("template flow: the minimal template scaffolds without memory", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("HelloApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a template");
    await r.press("down"); // agent-python-strands-container
    await r.press("down"); // agent-python-langchain
    await r.press("down"); // environment-python-bma
    await r.press("down"); // agent-python-minimal
    await waitForText(r.lastFrame, "● agent-python-minimal ");
    await r.press("return");

    // Straight to review: the minimal template takes no model-provider override.
    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).not.toContain("choose a model provider");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./HelloApp", 5000);

    expect(inputs[0]).toEqual({
      name: "HelloApp",
      skipInstall: false,
      skipGit: false,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-minimal", {
        runtimeName: "agent",
      }),
    });

    const spec = await Bun.file(join(directory, "HelloApp", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toEqual(["agent"]);
    expect(spec.memories ?? []).toHaveLength(0);
    r.unmount();
  }, 10000);

  test("template flow: the LangChain template hands the preset to create", async () => {
    cleanups.push((await inTempDirectory()).cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("LangChainApp");
    await r.press("return");

    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a template");
    await r.press("down"); // agent-python-strands-container
    await r.press("down"); // agent-python-langchain
    await waitForText(r.lastFrame, "● agent-python-langchain");
    await r.press("return");

    // No model step: langchain is Bedrock-only today (no override support).
    await waitForText(r.lastFrame, "this project will be created");
    expect(r.lastFrame()).not.toContain("choose a model provider");
    expect(r.lastFrame()).toContain("agent-python-langchain");
    await r.press("return");
    await waitForText(r.lastFrame, "✔ project created in ./LangChainApp", 5000);

    expect(inputs).toEqual([
      {
        name: "LangChainApp",
        skipInstall: false,
        skipGit: false,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-langchain", {
          runtimeName: "agent",
        }),
      },
    ]);
    r.unmount();
  }, 10000);

  test("template flow: the empty template creates a project with no runtime", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const core = new TestCoreClient();
    const inputs = spyOnCreate(core);
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("EmptyApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
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
    const r = renderScreen("/agentcore/create");

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
    const r = renderScreen("/agentcore/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("bedrock");
    await waitForText(r.lastFrame, "conflicts with a reserved package dependency");
    await r.press("return");
    expect(r.lastFrame()).toContain("name your project");
    r.unmount();
  });

  test("a pasted chunk with a trailing return keeps the name clean", async () => {
    const r = renderScreen("/agentcore/create");

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
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    r.unmount();
  });

  test("esc steps back through the flow and leaves from the first step", async () => {
    const r = renderScreen("/agentcore/create");

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("escape");
    await waitForText(r.lastFrame, "name your project");
    // Esc on the first step lands on the root menu.
    await r.press("escape");
    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });

  test("selecting create from the root menu opens the wizard", async () => {
    const r = renderScreen("/agentcore");

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
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
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
    cleanups.push((await inTempDirectory()).cleanup);
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
    const r = renderScreen("/agentcore/create", { core });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
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
    const { path, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const deep = join(path, "n".repeat(120));
    await mkdir(deep);
    process.chdir(deep);
    const r = renderScreen("/agentcore/create", { platform: "win32" });

    await waitForText(r.lastFrame, "name your project");
    await r.write("DemoApp");
    await r.press("return");
    await waitForText(r.lastFrame, "what kind of agent to start with?");
    await r.press("down"); // harness
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model provider");
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
    cleanups.push((await inTempDirectory()).cleanup); // hygiene: nothing must be created outside a temp dir
    const { streams, stdin } = ttyTestIO();
    const root = buildRoot(streams.io);

    // outcome never rejects, so a mid-pump failure cannot trip bun's
    // unhandled-rejection detection before the final assertion.
    const outcome = root.route(["node", "agentcore", "create"]).then(
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

  test("successful TUI create leaves the launch command in the restored terminal", async () => {
    const { streams, stdin } = ttyTestIO();
    const core = new TestCoreClient();
    core.projectManager.create = (input) =>
      (async function* () {
        yield { type: "step" as const, message: "creating project directory" };
        return {
          name: input.name,
          rootPath: join(process.cwd(), input.name),
          spec: ProjectSpecSchema.parse({ name: input.name, version: 2 }),
        };
      })();
    const root = buildRoot(streams.io, core);

    const outcome = root.route(["node", "agentcore", "create"]);

    await waitFor(() => streams.stdout().includes("name your project"));
    stdin.write("DemoApp");
    await waitFor(() => streams.stdout().includes("DemoApp"));
    stdin.write("\r");
    await waitFor(() => streams.stdout().includes("what kind of agent to start with?"));
    stdin.write("\r");
    await waitFor(() => streams.stdout().includes("choose a template"));
    stdin.write("\r");
    await waitFor(() => streams.stdout().includes("choose a model provider"));
    stdin.write("\r"); // focus the (Bedrock) model id
    await waitFor(() => streams.stdout().includes("model ID"));
    stdin.write("\r"); // accept it
    await waitFor(() => streams.stdout().includes("this project will be created"));
    stdin.write("\r");
    await waitFor(() => streams.stdout().includes("project created in ./DemoApp"));

    expect(streams.stdout()).not.toContain("cd DemoApp/ && agentcore");
    stdin.write("\r");
    await outcome;

    expect(streams.stdout()).toContain("Next step:\n  cd DemoApp/ && agentcore");
  }, 10000);

  test("bare create without a TTY stays headless and reports the missing --name", async () => {
    const io = testIO();
    const root = buildRoot(io.io);

    const error: unknown = await root
      .route(["node", "agentcore", "create"])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name' not specified");
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    const { streams } = ttyTestIO();
    const root = buildRoot(streams.io);

    const error: unknown = await root
      .route(["node", "agentcore", "create", "--skip-git"])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name' not specified");
  });

  test("--json stays headless even in a TTY", async () => {
    const { streams } = ttyTestIO();
    const root = buildRoot(streams.io);

    const error: unknown = await root
      .route(["node", "agentcore", "create", "--json"])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name' not specified");
  });

  test("flag-driven create still runs headless in a TTY session", async () => {
    const { path: directory, cleanup } = await inTempDirectory();
    cleanups.push(cleanup);
    const { streams } = ttyTestIO();
    const root = buildRoot(streams.io);

    await root.route([
      "node",
      "agentcore",
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
