import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import { RATING_SCALE_PRESETS } from "./llm-as-a-judge/ratingScales";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness("add-evaluator-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

const MODEL = "anthropic.claude-3-5-sonnet-20240620-v1:0";

describe("project add evaluator menu", () => {
  test("lists the evaluator kinds and opens the picked one", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/evaluator");

    await waitForText(r.lastFrame, "agentcore → project → add → evaluator");
    expect(r.lastFrame()).toContain("llm-as-a-judge");
    await r.press("return");

    await waitForText(r.lastFrame, "what should this evaluator be called?");
    r.unmount();
  });
});

describe("project add evaluator llm-as-a-judge wizard", () => {
  test("a preset scale expands exactly as --rating-scale <preset> does", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/evaluator/llm-as-a-judge");

    await waitForText(r.lastFrame, "what should this evaluator be called?");
    await r.write("judge");
    await r.press("return");

    await waitForText(r.lastFrame, "what should the judge score?");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "which Bedrock model should act as the judge?");
    await r.write("not a model");
    await r.press("return");
    await waitForFlatText(r.lastFrame, "expected a Bedrock model ID");
    for (let i = 0; i < "not a model".length; i++) await r.write("\x7f");
    await r.write(MODEL);
    await r.press("return");

    await waitForText(r.lastFrame, "how should the judge score a session?");
    await r.write("Rate {context} for helpfulness.");
    await r.write("\x04");

    await waitForText(r.lastFrame, "which rating scale should the judge use?");
    expect(r.lastFrame()).toContain("● 1-5-quality");
    expect(r.lastFrame()).toContain("custom");
    await r.press("return");

    // A preset was picked, so no JSON step follows.
    await waitForText(r.lastFrame, "what does this evaluator measure?");
    await r.press("return");

    await waitForText(r.lastFrame, "this evaluator will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("level TRACE");
    expect(review).toContain("rating scale 1-5-quality");
    await r.press("return");

    await waitForText(r.lastFrame, "added evaluator 'judge'");

    const evaluators = (await projectSpec(projectRoot)).evaluators;
    expect(evaluators).toEqual([
      {
        name: "judge",
        level: "TRACE",
        config: {
          llmAsAJudge: {
            model: MODEL,
            instructions: "Rate {context} for helpfulness.",
            ratingScale: RATING_SCALE_PRESETS["1-5-quality"],
          },
        },
      },
    ]);
    r.unmount();
  });

  test("custom opens a JSON step that validates the scale's shape", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/evaluator/llm-as-a-judge");

    await waitForText(r.lastFrame, "what should this evaluator be called?");
    await r.write("pass_fail");
    await r.press("return");
    await waitForText(r.lastFrame, "what should the judge score?");
    await r.press("return");
    await waitForText(r.lastFrame, "which Bedrock model should act as the judge?");
    await r.write(MODEL);
    await r.press("return");
    await waitForText(r.lastFrame, "how should the judge score a session?");
    await r.write("Did it work?");
    await r.write("\x04");

    await waitForText(r.lastFrame, "which rating scale should the judge use?");
    // The last entry, after the four presets, is "custom".
    for (let i = 0; i < 4; i++) await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "paste the rating scale as JSON");
    await r.write('{"numerical": [], "categorical": []}');
    await r.press("return");
    await waitForFlatText(r.lastFrame, "either numerical or categorical, not both");
    r.unmount();

    const again = renderScreen("/agentcore/project/add/evaluator/llm-as-a-judge");
    await waitForText(again.lastFrame, "what should this evaluator be called?");
    await again.write("pass_fail");
    await again.press("return");
    await waitForText(again.lastFrame, "what should the judge score?");
    await again.press("return");
    await waitForText(again.lastFrame, "which Bedrock model should act as the judge?");
    await again.write(MODEL);
    await again.press("return");
    await waitForText(again.lastFrame, "how should the judge score a session?");
    await again.write("Did it work?");
    await again.write("\x04");
    await waitForText(again.lastFrame, "which rating scale should the judge use?");
    for (let i = 0; i < 4; i++) await again.press("down");
    await again.press("return");
    await waitForText(again.lastFrame, "paste the rating scale as JSON");
    await again.write(
      '{"categorical": [{"label": "PASS", "definition": "it worked"}, {"label": "FAIL", "definition": "it did not"}]}',
    );
    await again.press("return");
    await waitForText(again.lastFrame, "what does this evaluator measure?");
    await again.press("return");
    await waitForText(again.lastFrame, "this evaluator will be added to agentcore.json");
    expect(flatFrame(again.lastFrame)).toContain("rating scale custom");
    await again.press("return");
    await waitForText(again.lastFrame, "added evaluator 'pass_fail'");

    expect((await projectSpec(projectRoot)).evaluators[0].config.llmAsAJudge.ratingScale).toEqual({
      categorical: [
        { label: "PASS", definition: "it worked" },
        { label: "FAIL", definition: "it did not" },
      ],
    });
    again.unmount();
  });
});
