import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("add-online-eval-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

// The scaffolded project declares one runtime, hello_world, so the agent
// source is offered and preselected.
describe("project add online-eval wizard", () => {
  test("agent source: writes the same config the flag path writes", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/online-eval");

    await waitForText(r.lastFrame, "what should this online evaluation config be called?");
    await r.write("prod_quality");
    await r.press("return");

    await waitForText(r.lastFrame, "what should this evaluation config monitor?");
    expect(r.lastFrame()).toContain("● a project agent");
    await r.press("return");

    await waitForText(r.lastFrame, "which agent's traffic should be sampled?");
    expect(r.lastFrame()).toContain("● hello_world");
    await r.press("return");

    await waitForText(r.lastFrame, "scope to one endpoint?");
    await r.press("return");

    // No project evaluators, so the built-in step is the only one and required.
    await waitForText(r.lastFrame, "which evaluators should score the sessions?");
    await r.press("return");
    await waitForText(r.lastFrame, "evaluators is required");
    await r.write("Builtin.Helpfulness, Builtin.Correctness");
    await r.press("return");

    await waitForText(r.lastFrame, "what share of sessions should be sampled?");
    await r.write("200");
    await r.press("return");
    await waitForFlatText(r.lastFrame, "<=100");
    // Backspaces one at a time: a multi-character chunk reads as a paste.
    for (let i = 0; i < 3; i++) await r.write("\x7f");
    await r.write("25");
    await r.press("return");

    await waitForText(r.lastFrame, "should evaluation start when this deploys?");
    await r.press("return");
    await waitForText(r.lastFrame, "what is this config for?");
    await r.press("return");

    await waitForText(r.lastFrame, "this config will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("agent hello_world");
    expect(review).toContain("sampling rate 25%");
    expect(review).toContain("evaluators Builtin.Helpfulness, Builtin.Correctness");
    await r.press("return");

    await waitForText(r.lastFrame, "added online-eval config 'prod_quality'");

    const configs = (await projectSpec(projectRoot)).onlineEvalConfigs;
    expect(configs).toEqual([
      {
        name: "prod_quality",
        agent: "hello_world",
        evaluators: ["Builtin.Helpfulness", "Builtin.Correctness"],
        samplingRate: 25,
        enableOnCreate: true,
      },
    ]);
    r.unmount();
  });

  test("log-group source: asks for log groups instead of an agent", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/online-eval");

    await waitForText(r.lastFrame, "what should this online evaluation config be called?");
    await r.write("custom_logs");
    await r.press("return");

    await waitForText(r.lastFrame, "what should this evaluation config monitor?");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "which CloudWatch log groups?");
    expect(r.lastFrame()).not.toContain("which agent");
    await r.write("/aws/one, /aws/two");
    await r.press("return");

    await waitForText(r.lastFrame, "filter traces to particular services?");
    await r.write("checkout");
    await r.press("return");

    await waitForText(r.lastFrame, "which evaluators should score the sessions?");
    await r.write("Builtin.Helpfulness");
    await r.press("return");
    await waitForText(r.lastFrame, "what share of sessions should be sampled?");
    await r.write("5");
    await r.press("return");
    await waitForText(r.lastFrame, "should evaluation start when this deploys?");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "what is this config for?");
    await r.press("return");
    await waitForText(r.lastFrame, "this config will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("on deploy paused");
    await r.press("return");
    await waitForText(r.lastFrame, "added online-eval config 'custom_logs'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs[0]).toMatchObject({
      logGroupNames: ["/aws/one", "/aws/two"],
      serviceNames: ["checkout"],
      enableOnCreate: false,
    });
    r.unmount();
  });

  test("offers the project's evaluators, making the built-in step optional", async () => {
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
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "--instructions",
      "Score {context}.",
      "--rating-scale",
      "1-5-quality",
    ]);
    const r = renderScreen("/agentcore/project/add/online-eval");

    await waitForText(r.lastFrame, "what should this online evaluation config be called?");
    await r.write("judged");
    await r.press("return");
    await waitForText(r.lastFrame, "what should this evaluation config monitor?");
    await r.press("return");
    await waitForText(r.lastFrame, "which agent's traffic should be sampled?");
    await r.press("return");
    await waitForText(r.lastFrame, "scope to one endpoint?");
    await r.press("return");

    await waitForText(r.lastFrame, "which of this project's evaluators should score the sessions?");
    await r.write(" ");
    await r.press("return");

    await waitForText(r.lastFrame, "any built-in evaluators as well?");
    await r.press("return");

    await waitForText(r.lastFrame, "what share of sessions should be sampled?");
    await r.write("10");
    await r.press("return");
    await waitForText(r.lastFrame, "should evaluation start when this deploys?");
    await r.press("return");
    await waitForText(r.lastFrame, "what is this config for?");
    await r.press("return");
    await waitForText(r.lastFrame, "this config will be added to agentcore.json");
    await r.press("return");
    await waitForText(r.lastFrame, "added online-eval config 'judged'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs[0].evaluators).toEqual(["judge"]);
    r.unmount();
  });
});
