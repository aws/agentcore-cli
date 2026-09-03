import { test, expect, describe, afterEach } from "bun:test";
import type { CreateHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the create-harness wizard: name → model → memory → tools
// → prompt → review → submit. Key input drives the whole flow;
// assertions check both what the user sees and the exact request Core receives.

const DEFAULT_MODEL = {
  bedrockModelConfig: { modelId: "us.anthropic.claude-sonnet-4-6" },
};

// The browser tool is enabled by default in the wizard, so an untouched tools
// step still sends it.
const BROWSER_TOOL = { type: "agentcore_browser", config: { agentCoreBrowser: {} } };

function coreForCreate(): TestCoreClient {
  const core = new TestCoreClient();
  core.harness.setCreateResponse({
    harness: {
      harnessId: "my_agent-Xyz12345",
      harnessName: "my_agent",
      status: "CREATING",
      harnessVersion: "1",
    },
  } as CreateHarnessResponse);
  return core;
}

describe("harness create wizard", () => {
  test("walks name → model → memory → tools → prompt → review and creates", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/create", { core });

    // Step: name.
    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");

    // Step: model — service default is preselected; pick bedrock instead and
    // enter a model id.
    await waitForText(r.lastFrame, "choose a model");
    expect(r.lastFrame()).toContain("● service default");
    await r.press("down"); // bedrock
    await waitForText(r.lastFrame, "● bedrock");
    await r.press("return"); // focus the model id field
    await r.write("us.anthropic.claude-sonnet-4-6");
    await r.press("return");

    // Step: memory — managed is preselected; keep it.
    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    expect(r.lastFrame()).toContain("● managed");
    await r.press("return");

    // Step: tools — browser is enabled by default; add a Gateway ARN.
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    expect(r.lastFrame()).toContain("[✓] browser");
    await r.press("down"); // gateway
    await r.write(" "); // opens the arn input
    await waitForText(r.lastFrame, "Gateway ARN");
    await r.write("arn:aws:bedrock-agentcore:us-east-1:123:gateway/g-1");
    await r.press("return"); // commit the arn
    await waitForText(r.lastFrame, "arn:aws:bedrock-agentcore:us-east-1:123:gateway/g-1");
    await r.press("return"); // continue

    // Step: prompt — type a prompt with a newline, then ctrl+d.
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("You are helpful.");
    await r.press("return"); // newline
    await r.write("Be brief.");
    await r.write("\x04"); // ctrl+d continues

    // Step: review — the request is shown as JSON.
    await waitForText(r.lastFrame, "sent to CreateHarness");
    expect(r.lastFrame()).toContain('"harnessName"');
    await r.press("return"); // create

    await waitForText(r.lastFrame, "harness created");
    expect(r.lastFrame()).toContain("my_agent-Xyz12345");

    const call = core.harness.calls.find((c) => c.method === "createHarness")!;
    expect(call.args[0]).toEqual({
      harnessName: "my_agent",
      model: DEFAULT_MODEL,
      memory: { managedMemoryConfiguration: {} },
      tools: [
        { type: "agentcore_browser", config: { agentCoreBrowser: {} } },
        {
          type: "agentcore_gateway",
          config: {
            agentCoreGateway: {
              gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123:gateway/g-1",
            },
          },
        },
      ],
      systemPrompt: [{ text: "You are helpful.\nBe brief." }],
    });

    // Enter moves on to the new harness's hub.
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → my_agent-Xyz12345");
    r.unmount();
  });

  test("reveals model fields only after enter and hides them again on escape", async () => {
    const r = renderScreen("/agentcore/harness/create", { core: coreForCreate() });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a model");
    await r.press("down"); // bedrock
    await waitForText(r.lastFrame, "● bedrock");
    expect(r.lastFrame()).not.toContain("model ID");

    await r.press("return");
    await waitForText(r.lastFrame, "model ID");

    await r.press("escape");
    await waitFor(() => !(r.lastFrame() ?? "").includes("model ID"));
    expect(r.lastFrame()).toContain("● bedrock");
    r.unmount();
  });

  test("selecting gemini collects the model id and api key arn", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/create", { core });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a model");
    await r.press("down"); // bedrock
    await r.press("down"); // gemini
    await waitForText(r.lastFrame, "● gemini");
    await r.press("return"); // focus the model id field
    await r.write("gemini-2.5-pro");
    await r.press("return"); // on to the api key arn field
    await r.write("arn:aws:bedrock-agentcore:us-east-1:123:token-vault/default/apikey/gemini");
    await r.press("return");

    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("return");
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "createHarness"));
    const call = core.harness.calls.find((c) => c.method === "createHarness")!;
    expect(call.args[0]).toEqual({
      harnessName: "my_agent",
      model: {
        geminiModelConfig: {
          modelId: "gemini-2.5-pro",
          apiKeyArn: "arn:aws:bedrock-agentcore:us-east-1:123:token-vault/default/apikey/gemini",
        },
      },
      memory: { managedMemoryConfiguration: {} },
      tools: [BROWSER_TOOL],
    });
    r.unmount();
  });

  test("openai requires the model id and api key arn and sends them", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/create", { core });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a model");
    await r.press("down"); // bedrock
    await r.press("down"); // gemini
    await r.press("down"); // openai
    await waitForText(r.lastFrame, "● openai");
    await r.press("return"); // focus the model id field
    await r.press("return"); // empty → error
    await waitForText(r.lastFrame, "enter an OpenAI model ID");
    await r.write("gpt-5");
    await r.press("return"); // on to the api key arn field
    await r.press("return"); // empty → error
    await waitForText(r.lastFrame, "enter an API-key credential provider ARN");
    await r.write("arn:aws:bedrock-agentcore:us-east-1:123:token-vault/default/apikey/openai");
    await r.press("return");

    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("return");
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "createHarness"));
    const call = core.harness.calls.find((c) => c.method === "createHarness")!;
    expect(call.args[0]).toEqual({
      harnessName: "my_agent",
      model: {
        openAiModelConfig: {
          modelId: "gpt-5",
          apiKeyArn: "arn:aws:bedrock-agentcore:us-east-1:123:token-vault/default/apikey/openai",
        },
      },
      memory: { managedMemoryConfiguration: {} },
      tools: [BROWSER_TOOL],
    });
    r.unmount();
  });

  test("litellm omits the optional fields left empty", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/create", { core });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a model");
    await r.press("down"); // bedrock
    await r.press("down"); // gemini
    await r.press("down"); // openai
    await r.press("down"); // litellm
    await waitForText(r.lastFrame, "● litellm");
    await r.press("return"); // focus the model id field
    await r.write("anthropic/claude-3-sonnet");
    await r.press("return"); // api key arn — optional, leave empty
    await r.press("return"); // api base url — optional, leave empty
    await r.press("return");

    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("return");
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "createHarness"));
    const call = core.harness.calls.find((c) => c.method === "createHarness")!;
    expect(call.args[0]).toEqual({
      harnessName: "my_agent",
      model: { liteLlmModelConfig: { modelId: "anthropic/claude-3-sonnet" } },
      memory: { managedMemoryConfiguration: {} },
      tools: [BROWSER_TOOL],
    });
    r.unmount();
  });

  test("service default sends no model", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/create", { core });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");

    // Service default is the first option and preselected.
    await waitForText(r.lastFrame, "choose a model");
    expect(r.lastFrame()).toContain("● service default");
    await r.press("return");

    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("return");
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.press("return"); // enter on an empty prompt continues
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "createHarness"));
    const call = core.harness.calls.find((c) => c.method === "createHarness")!;
    expect(call.args[0]).toEqual({
      harnessName: "my_agent",
      memory: { managedMemoryConfiguration: {} },
      tools: [BROWSER_TOOL],
    });
    r.unmount();
  });

  test("rejects an invalid name and stays on the name step", async () => {
    const r = renderScreen("/agentcore/harness/create", { core: coreForCreate() });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("9bad name");
    await r.press("return");
    // The error line (distinct from the always-visible help text) is shown and
    // the wizard stays on the name step.
    await waitForText(r.lastFrame, "letters, numbers, and underscores only");
    expect(r.lastFrame()).toContain("the name of your harness");
    r.unmount();
  });

  test("bring-your-own memory requires an ARN", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/create", { core });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return"); // service default — no model sent

    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("down"); // bring your own
    await waitForText(r.lastFrame, "● bring your own");
    await r.press("return"); // focus the memory arn field
    await r.press("return"); // empty → error
    await waitForText(r.lastFrame, "enter the ARN of an existing AgentCore Memory");
    await r.write("arn:aws:bedrock-agentcore:us-east-1:123:memory/m-1");
    await r.press("return");

    // Skip through tools/prompt to review.
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "createHarness"));
    const call = core.harness.calls.find((c) => c.method === "createHarness")!;
    expect(call.args[0]).toEqual({
      harnessName: "my_agent",
      memory: {
        agentCoreMemoryConfiguration: {
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:memory/m-1",
        },
      },
      tools: [BROWSER_TOOL],
    });
    r.unmount();
  });

  test("shows the service error and returns to the form on esc", async () => {
    const core = coreForCreate();
    core.harness.createHarness = async () => {
      throw new Error("name already exists");
    };
    const r = renderScreen("/agentcore/harness/create", { core });

    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return"); // service default — no model sent
    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("return");
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");

    await waitForText(r.lastFrame, "name already exists");
    await r.press("escape");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    r.unmount();
  });

  test("esc from the hub after creating returns to the menu, not the wizard", async () => {
    const core = coreForCreate();
    core.harness.setGetResponse({
      harness: {
        harnessId: "my_agent-Xyz12345",
        harnessName: "my_agent",
        arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/my_agent-Xyz12345",
        executionRoleArn: "arn:aws:iam::123:role/MyRole",
        status: "READY",
      },
    } as never);
    const r = renderScreen("/agentcore/harness/create", { core });

    // Fastest path through the wizard: defaults everywhere.
    await waitForText(r.lastFrame, "the name of your harness");
    await r.write("my_agent");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    await r.press("return"); // service default — no model sent
    await waitForText(r.lastFrame, "how should the harness remember conversations?");
    await r.press("return");
    await waitForText(r.lastFrame, "which tools should the agent be able to use?");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to CreateHarness");
    await r.press("return");
    await waitForText(r.lastFrame, "harness created");
    await r.press("return"); // on to the hub
    await waitForText(
      r.lastFrame,
      "arn:aws:bedrock-agentcore:us-east-1:123:harness/my_agent-Xyz12345",
    );

    // Esc from the hub: the finished wizard must not come back.
    await r.press("escape");
    await waitForText(r.lastFrame, "manage AgentCore harnesses");
    expect(r.lastFrame()).not.toContain("the name of your harness");
    r.unmount();
  });

  test("esc on the first step leaves the wizard", async () => {
    const core = coreForCreate();
    core.harness.setListResponse({ harnesses: [] });
    // Arrive from the harness menu so esc has somewhere to pop back to.
    const r = renderScreen("/agentcore/harness", { core });
    // `create` is the first menu item, so it is already selected.
    await waitForText(r.lastFrame, "❯ create");
    await r.press("return");
    await waitForText(r.lastFrame, "the name of your harness");

    await r.press("escape");
    await waitForText(r.lastFrame, "manage AgentCore harnesses");
    r.unmount();
  });
});
