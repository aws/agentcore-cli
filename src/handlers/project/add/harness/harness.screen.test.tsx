import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { parse } from "yaml";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../testing";
import { createRootHandler } from "../../../index";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { DEFAULT_HARNESS_MODEL } from "../../../../projectSchemas/harness";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import { projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("add-harness-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

async function harnessYaml(projectRoot: string, name: string) {
  return parse(await Bun.file(join(projectRoot, "app", name, "harness.yaml")).text());
}

async function systemPromptOf(projectRoot: string, name: string) {
  return Bun.file(join(projectRoot, "app", name, "system-prompt.md")).text();
}

// reachModelStep answers the name and prompt steps, leaving the wizard on the
// model step: where every test about the model provider starts.
async function reachModelStep(screen: RenderScreenResult, name: string): Promise<void> {
  await waitForText(screen.lastFrame, "what should this harness be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "what is the agent's system prompt?");
  await screen.write("You are a pirate.");
  await screen.press("ctrl+d");
  await waitForText(screen.lastFrame, "choose a model provider");
}

// acceptDefaultModel confirms the preselected provider and its default model
// ID: enter opens the model ID input, enter again accepts what is in it.
async function acceptDefaultModel(screen: RenderScreenResult): Promise<void> {
  await screen.press("return");
  await waitForText(screen.lastFrame, DEFAULT_HARNESS_MODEL.modelId);
  await screen.press("return");
}

describe("project add harness wizard", () => {
  test("collects a name, prompt and model, then scaffolds the same harness as the flags", async () => {
    const projectRoot = await inProject();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const screen = renderScreen("/agentcore/add/harness", { queryClient });

    await waitForText(screen.lastFrame, "what should this harness be called?");
    expect(flatFrame(screen.lastFrame)).toContain("letters, digits and underscores");
    await screen.write("assistant");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the agent's system prompt?");
    expect(screen.lastFrame()).toContain("[enter] newline");
    expect(screen.lastFrame()).toContain("[ctrl+d] continue");
    await screen.write("You are a pirate.");
    await screen.press("return");
    await screen.write("Answer in rhyme.");
    // Enter added a line rather than moving on.
    expect(screen.lastFrame()).toContain("what is the agent's system prompt?");
    await screen.press("ctrl+d");

    // The model step is the one `agentcore create` asks for a config-based
    // project: the same provider list, bedrock preselected, and the fields
    // hidden until the provider is confirmed.
    await waitForText(screen.lastFrame, "choose a model provider");
    expect(screen.lastFrame()).toContain("● model provider ──");
    expect(screen.lastFrame()).toContain("❯ ● bedrock");
    expect(screen.lastFrame()).toContain("○ openai");
    expect(screen.lastFrame()).toContain("○ gemini");
    expect(screen.lastFrame()).toContain("○ litellm");
    expect(screen.lastFrame()).not.toContain("model ID");
    await screen.press("return");
    await waitForText(screen.lastFrame, DEFAULT_HARNESS_MODEL.modelId);
    await screen.press("return");

    await waitForText(screen.lastFrame, "this harness will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("harness assistant");
    expect(review).toContain("provider bedrock");
    expect(review).toContain(`model ${DEFAULT_HARNESS_MODEL.modelId}`);
    expect(review).toContain("system prompt You are a pirate. · 2 lines");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added harness 'assistant' to 'TestProject'");
    expect(screen.lastFrame()).toContain("agentcore deploy");
    expect(screen.lastFrame()).toContain("[enter] go back");

    // The same files `add harness --name assistant --system-prompt …` writes:
    // the prompt in system-prompt.md, the rest in harness.yaml.
    expect(await systemPromptOf(projectRoot, "assistant")).toBe(
      "You are a pirate.\nAnswer in rhyme.",
    );
    const yaml = await harnessYaml(projectRoot, "assistant");
    expect(yaml).toMatchObject({ name: "assistant", model: DEFAULT_HARNESS_MODEL });
    expect(yaml.systemPrompt).toBeUndefined();
    expect((await projectSpec(projectRoot)).harnesses).toContainEqual({
      name: "assistant",
      path: "app/assistant",
    });
    expect(
      queryClient
        .getQueryData<Project>(projectQueryKey())
        ?.spec.harnesses.some((harness) => harness.name === "assistant"),
    ).toBe(true);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("a blank system prompt is refused", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/harness");

    await waitForText(screen.lastFrame, "what should this harness be called?");
    await screen.write("assistant");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what is the agent's system prompt?");

    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "System prompt is required");
    expect(screen.lastFrame()).not.toContain("choose a model provider");

    // Enter on the empty editor answers the step the same way.
    await screen.press("return");
    expect(screen.lastFrame()).toContain("System prompt is required");
    expect(screen.lastFrame()).not.toContain("choose a model provider");
    screen.unmount();
  });

  test("a provider other than Bedrock asks for its model ID and API key ARN", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/harness");
    await reachModelStep(screen, "assistant");

    await screen.press("down");
    // The pointer and the radio marker travel together, as in every radio step.
    await waitForText(screen.lastFrame, "❯ ● openai");
    expect(screen.lastFrame()).toContain("○ bedrock");
    await screen.press("return");

    // The inputs open in place under the list, the model ID prefilled with the
    // provider's default. The pointer follows focus into them while the radio
    // marker keeps showing the choice.
    await waitForText(screen.lastFrame, "model ID");
    expect(screen.lastFrame()).toContain("gpt-5");
    expect(screen.lastFrame()).toContain("API key ARN");
    expect(screen.lastFrame()).toContain("● openai");
    expect(screen.lastFrame()).not.toContain("❯ ● openai");
    await screen.press("return"); // on to the API key ARN
    await screen.press("return"); // empty → the field says what is missing
    await waitForText(screen.lastFrame, "enter an API key ARN for openai");
    const apiKeyArn =
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/OpenAIKey";
    await screen.write(apiKeyArn);
    await screen.press("return");

    await waitForText(screen.lastFrame, "this harness will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("provider openai");
    expect(review).toContain("model gpt-5");
    expect(review.replace(/\s/g, "")).toContain(apiKeyArn);
    await screen.press("return");

    await waitForText(screen.lastFrame, "added harness 'assistant'");
    expect((await harnessYaml(projectRoot, "assistant")).model).toEqual({
      provider: "open_ai",
      modelId: "gpt-5",
      apiKeyArn,
    });
    screen.unmount();
  }, 15000);

  test("LiteLLM takes an optional API base URL and writes it", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/harness");
    await reachModelStep(screen, "assistant");

    await screen.press("down"); // openai
    await screen.press("down"); // gemini
    await screen.press("down"); // litellm
    await waitForText(screen.lastFrame, "❯ ● litellm");
    await screen.press("return");

    // LiteLLM is the one provider with an API base; its key is optional.
    await waitForText(screen.lastFrame, "API base URL");
    expect(screen.lastFrame()).toContain(`bedrock/${DEFAULT_HARNESS_MODEL.modelId}`);
    await screen.press("return"); // keep the default model ID
    await screen.press("return"); // no API key ARN
    await screen.write("https://llm.example.com/v1");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this harness will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("provider litellm");
    expect(review).toContain("API base URL https://llm.example.com/v1");
    expect(review).not.toContain("API key ARN");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added harness 'assistant'");
    expect((await harnessYaml(projectRoot, "assistant")).model).toEqual({
      provider: "lite_llm",
      modelId: `bedrock/${DEFAULT_HARNESS_MODEL.modelId}`,
      apiBase: "https://llm.example.com/v1",
    });
    screen.unmount();
  }, 15000);

  test("an edited model ID is what gets written", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/harness");
    await reachModelStep(screen, "custom_model");

    await screen.press("return");
    await waitForText(screen.lastFrame, "model ID");
    // The input opens on the default ID; typing extends it.
    await screen.write("-test");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this harness will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain(`model ${DEFAULT_HARNESS_MODEL.modelId}-test`);
    await screen.press("return");

    await waitForText(screen.lastFrame, "added harness 'custom_model'");
    expect((await harnessYaml(projectRoot, "custom_model")).model).toEqual({
      provider: "bedrock",
      modelId: `${DEFAULT_HARNESS_MODEL.modelId}-test`,
    });
    screen.unmount();
  }, 15000);

  test("esc collapses the model inputs back into the provider list", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/harness");
    await reachModelStep(screen, "assistant");

    await screen.press("return");
    await waitForText(screen.lastFrame, "model ID");

    await screen.press("escape");

    await waitFor(() => !(screen.lastFrame() ?? "").includes("model ID"));
    expect(screen.lastFrame()).toContain("❯ ● bedrock");
    expect(screen.lastFrame()).toContain("choose a model provider");
    screen.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/harness");

    await waitForText(screen.lastFrame, "what should this harness be called?");
    await screen.write("1agent");

    await waitForText(screen.lastFrame, "Must begin with a letter");
    screen.unmount();
  });

  test("validates the deployed name against the longest project target", async () => {
    const projectRoot = await inProject();
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "production", account: "111122223333", region: "us-east-1" }]),
    );
    // 20 characters: legal on its own, three over once the project and the
    // target are prefixed.
    const name = `h${"x".repeat(19)}`;
    const screen = renderScreen("/agentcore/add/harness");

    await waitForText(screen.lastFrame, "what should this harness be called?");
    await screen.write(name);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "is 43 characters. The maximum is 40.");
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain("TestProject_production_");
    expect(frame).toContain("what should this harness be called?");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    // The name is taken, so addResource refuses it — the realistic failure, and
    // one the user can fix without starting over.
    await run(["add", "harness", "--name", "assistant"]);
    const screen = renderScreen("/agentcore/add/harness");
    await reachModelStep(screen, "assistant");
    await acceptDefaultModel(screen);
    await waitForText(screen.lastFrame, "this harness will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "a harness with name 'assistant' already exists");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this harness will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("harness assistant");

    expect((await projectSpec(projectRoot)).harnesses).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/harness");

    await waitForText(screen.lastFrame, "what should this harness be called?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add harness`
// has to reach the wizard, and everything else has to stay headless.
describe("project add harness dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "harness", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  // --name is optional at the flag level so the TUI middleware can see a bare
  // command; headless, the spec schema is what reports it missing.
  function expectMissingName(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("name");
  }

  test("bare add harness in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "harness"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The wizard never finishes on its own; Ctrl+C (re-sent until the app
    // reacts, slowly enough that repeats cannot coalesce into one chunk) closes
    // it and resolves the route cleanly. The headless branch would instead
    // reject with the missing name.
    await waitFor(
      () => {
        if (!settled) stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(streams.stderr()).not.toContain("at name");
  }, 10000);

  test("bare add harness without a TTY stays headless and reports the missing name", async () => {
    await inProject();

    expectMissingName(await routeError(testIO().io, []));
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    expectMissingName(
      await routeError(ttyTestIO().streams.io, ["--system-prompt", "You are a pirate."]),
    );
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    expectMissingName(await routeError(ttyTestIO().streams.io, ["--json"]));
  });

  test("flag-driven add harness still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "harness",
      "--name",
      "flag_harness",
    ]);

    expect((await projectSpec(projectRoot)).harnesses).toContainEqual({
      name: "flag_harness",
      path: "app/flag_harness",
    });
  }, 10000);
});
