import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import {
  cleanupScreens,
  flatFrame,
  renderScreen,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../../testing";
import { createGatewayProjectTestHarness } from "../../gateway-test-support";
import { projectQueryKey } from "../../../ProjectGate";
import type { Project } from "../../../types";
import { RATING_SCALE_PRESETS } from "./ratingScales";
import { DEFAULT_JUDGE_MODEL } from "./screen";

const { cleanup, inProject, projectSpec, run } = createGatewayProjectTestHarness(
  "add-llm-as-a-judge-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

const INSTRUCTIONS = "Rate the response: {assistant_turn}";

async function evaluatorOf(projectRoot: string, name: string) {
  return ((await projectSpec(projectRoot)).evaluators ?? []).find(
    (evaluator: { name: string }) => evaluator.name === name,
  );
}

async function reachModelStep(screen: RenderScreenResult, name: string): Promise<void> {
  await waitForText(screen.lastFrame, "what should this evaluator be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "what should it score?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "which model should judge?");
}

async function finishFromInstructions(screen: RenderScreenResult): Promise<void> {
  await waitForText(screen.lastFrame, "how should the judge score it?");
  await screen.write(INSTRUCTIONS);
  await screen.press("ctrl+d");
  await waitForText(screen.lastFrame, "which rating scale?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
}

describe("project add evaluator llm-as-a-judge wizard", () => {
  test("adds the same evaluator as the flags", async () => {
    const projectRoot = await inProject();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const screen = renderScreen("/agentcore/add/evaluator/llm-as-a-judge", { queryClient });

    await waitForText(screen.lastFrame, "what should this evaluator be called?");
    await screen.write("helpfulness");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should it score?");
    expect(screen.lastFrame()).toContain("❯ ● SESSION");
    expect(screen.lastFrame()).toContain("score each agent response");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● TRACE");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which model should judge?");
    expect(screen.lastFrame()).toContain("❯ ● Bedrock");
    expect(screen.lastFrame()).toContain("○ OpenResponses");
    await screen.press("return");
    await waitForText(screen.lastFrame, DEFAULT_JUDGE_MODEL);
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should the judge score it?");
    expect(screen.lastFrame()).toContain("{context}");
    expect(screen.lastFrame()).toContain("[ctrl+d] continue");
    await screen.write("Rate the response: {assistant_turn}");
    await screen.press("return");
    await screen.write("Conversation: {context}");
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "which rating scale?");
    expect(screen.lastFrame()).toContain(
      "❯ ● 1-5-quality       numerical · 1 Very Poor, 2 Poor, 3 Fair, 4 Good, 5 Excellent",
    );
    expect(screen.lastFrame()).toContain("categorical · pass, fail");
    await screen.press("down");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● pass-fail");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("evaluator helpfulness");
    expect(review).toContain("level TRACE");
    expect(review).toContain("provider Bedrock");
    expect(review).toContain(`model ${DEFAULT_JUDGE_MODEL}`);
    expect(review).toContain("instructions Rate the response: {assistant_turn} (+1 more line)");
    expect(review).toContain("rating scale pass-fail");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added evaluator 'helpfulness' to 'TestProject'");
    expect(screen.lastFrame()).toContain("agentcore deploy");
    const added = await evaluatorOf(projectRoot, "helpfulness");
    expect(added).toEqual({
      name: "helpfulness",
      level: "TRACE",
      config: {
        llmAsAJudge: {
          model: DEFAULT_JUDGE_MODEL,
          instructions: "Rate the response: {assistant_turn}\nConversation: {context}",
          ratingScale: RATING_SCALE_PRESETS["pass-fail"],
        },
      },
    });
    expect(
      queryClient
        .getQueryData<Project>(projectQueryKey())
        ?.spec.evaluators?.some((evaluator) => evaluator.name === "helpfulness"),
    ).toBe(true);

    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "flags",
      "--level",
      "TRACE",
      "--model",
      DEFAULT_JUDGE_MODEL,
      "--instructions",
      "Rate the response: {assistant_turn}\nConversation: {context}",
      "--rating-scale",
      "pass-fail",
    ]);
    expect({ ...(await evaluatorOf(projectRoot, "flags")), name: "helpfulness" }).toEqual(added);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add a custom evaluator to the current project");
    screen.unmount();
  }, 20000);

  test("OpenResponses takes its own model ID and is written explicitly", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/evaluator/llm-as-a-judge");
    await reachModelStep(screen, "judge");

    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● OpenResponses");
    await screen.press("return");
    await waitForText(screen.lastFrame, "an OpenResponses model ID");
    await screen.write("openai.gpt-5.4");

    /** Each provider keeps its own answer, so Bedrock still opens on its default. **/
    await screen.press("escape");
    await screen.press("up");
    await screen.press("return");
    await waitForText(screen.lastFrame, DEFAULT_JUDGE_MODEL);
    await screen.press("escape");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "openai.gpt-5.4");
    await screen.press("return");

    await finishFromInstructions(screen);
    expect(flatFrame(screen.lastFrame)).toContain("provider OpenResponses");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added evaluator 'judge'");
    expect((await evaluatorOf(projectRoot, "judge")).config.llmAsAJudge).toMatchObject({
      modelProvider: "OpenResponses",
      model: "openai.gpt-5.4",
    });
    screen.unmount();
  }, 20000);

  test.each([
    /** Bedrock opens on its default ID, so a trailing word breaks it. **/
    ["Bedrock", [], " x", "Must be a Bedrock model ID"],
    ["OpenResponses", ["down"], "bad model", "Must be an OpenResponses model ID"],
  ] as const)(
    "a malformed %s model ID keeps the wizard on the model step",
    async (_provider, moves, typed, message) => {
      await inProject();
      const screen = renderScreen("/agentcore/add/evaluator/llm-as-a-judge");
      await reachModelStep(screen, "judge");
      for (const move of moves) await screen.press(move);
      await screen.press("return");
      await waitForText(screen.lastFrame, "model ID");
      await screen.write(typed);

      await screen.press("return");

      await waitForText(screen.lastFrame, message);
      expect(screen.lastFrame()).toContain("which model should judge?");
      screen.unmount();
    },
  );

  test("blank instructions are refused", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/evaluator/llm-as-a-judge");
    await reachModelStep(screen, "judge");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should the judge score it?");

    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "Instructions is required");
    expect(screen.lastFrame()).not.toContain("which rating scale?");
    screen.unmount();
  });

  test("validates the deployed name against the longest project target", async () => {
    const projectRoot = await inProject();
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "production", account: "111122223333", region: "us-east-1" }]),
    );
    const screen = renderScreen("/agentcore/add/evaluator/llm-as-a-judge");

    await waitForText(screen.lastFrame, "what should this evaluator be called?");
    await screen.write(`e${"x".repeat(24)}`);
    await waitForText(screen.lastFrame, `e${"x".repeat(24)}`);
    expect(screen.lastFrame()).not.toContain("The maximum is 48.");

    await screen.write("x");
    await waitForFlatText(screen.lastFrame, "is 49 characters. The maximum is 48.");
    expect(flatFrame(screen.lastFrame)).toContain("TestProject_production_");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "judge",
      "--level",
      "SESSION",
      "--model",
      DEFAULT_JUDGE_MODEL,
      "--instructions",
      INSTRUCTIONS,
      "--rating-scale",
      "pass-fail",
    ]);
    const screen = renderScreen("/agentcore/add/evaluator/llm-as-a-judge");
    await reachModelStep(screen, "judge");
    await screen.press("return");
    await screen.press("return");
    await finishFromInstructions(screen);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "a evaluator with name 'judge' already exists");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("evaluator judge");
    expect((await projectSpec(projectRoot)).evaluators).toHaveLength(1);
    screen.unmount();
  }, 20000);
});
