import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupScreens,
  flatFrame,
  renderScreen,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../../testing";
import { createGatewayProjectTestHarness } from "../../gateway-test-support";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("add-code-based-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

const LAMBDA_ARN = "arn:aws:lambda:us-west-2:123456789012:function:refund-policy";

async function evaluatorOf(projectRoot: string, name: string) {
  return ((await projectSpec(projectRoot)).evaluators ?? []).find(
    (evaluator: { name: string }) => evaluator.name === name,
  );
}

async function reachLambdaStep(screen: RenderScreenResult, name: string): Promise<void> {
  await waitForText(screen.lastFrame, "what should this evaluator be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "what should it score?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "which Lambda should score it?");
}

describe("project add evaluator code-based wizard", () => {
  test("scaffolds the same managed evaluator as the flags", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/evaluator/code-based");
    await reachLambdaStep(screen, "refund_policy");

    expect(screen.lastFrame()).toContain("❯ ● scaffold a new Lambda");
    expect(screen.lastFrame()).toContain("Python code in app/refund_policy");
    expect(screen.lastFrame()).toContain("○ timeout");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how long may it run?");
    expect(screen.lastFrame()).toContain("60");
    await screen.press("backspace");
    await screen.press("backspace");
    await screen.write("120");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("evaluator refund_policy");
    expect(review).toContain("level SESSION");
    expect(review).toContain("lambda scaffolded in app/refund_policy");
    expect(review).toContain("timeout 120 seconds");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added evaluator 'refund_policy' to 'TestProject'");
    await waitForFlatText(
      screen.lastFrame,
      "note: this evaluator returns Pass for every session until you implement app/refund_policy/lambda_function.py",
    );
    expect(
      await Bun.file(join(projectRoot, "app", "refund_policy", "lambda_function.py")).exists(),
    ).toBe(true);

    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "flags",
      "--level",
      "SESSION",
      "--timeout-seconds",
      "120",
    ]);
    const flags = await evaluatorOf(projectRoot, "flags");
    expect(await evaluatorOf(projectRoot, "refund_policy")).toEqual({
      ...flags,
      name: "refund_policy",
      config: {
        codeBased: {
          managed: { ...flags.config.codeBased.managed, codeLocation: "app/refund_policy" },
        },
      },
    });

    await screen.press("return");
    await waitForText(screen.lastFrame, "add a custom evaluator to the current project");
    screen.unmount();
  }, 20000);

  test("an existing Lambda skips the timeout and writes an external config", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/evaluator/code-based");
    await reachLambdaStep(screen, "refund_policy");

    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● use an existing Lambda");
    expect(screen.lastFrame()).not.toContain("timeout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Lambda ARN");
    await screen.write(LAMBDA_ARN);
    await screen.press("return");

    await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review.replace(/\s/g, "")).toContain(`lambda${LAMBDA_ARN}`);
    expect(review).not.toContain("timeout");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added evaluator 'refund_policy'");
    expect(screen.lastFrame()).not.toContain("returns Pass");
    expect((await evaluatorOf(projectRoot, "refund_policy")).config).toEqual({
      codeBased: { external: { lambdaArn: LAMBDA_ARN } },
    });
    expect(await Bun.file(join(projectRoot, "app", "refund_policy")).exists()).toBe(false);
    screen.unmount();
  }, 20000);

  test.each([
    [
      "a malformed Lambda ARN",
      ["down", "return"],
      "refund-policy",
      "Must be a valid Lambda function ARN",
    ],
    ["a timeout past 300 seconds", ["return"], "0", "Too big: expected number to be <=300"],
  ] as const)("%s keeps the wizard on its step", async (_label, moves, typed, message) => {
    await inProject();
    const screen = renderScreen("/agentcore/add/evaluator/code-based");
    await reachLambdaStep(screen, "refund_policy");
    for (const move of moves) await screen.press(move);
    await screen.write(typed);

    await screen.press("return");

    await waitForText(screen.lastFrame, message);
    expect(screen.lastFrame()).not.toContain("this evaluator will be added");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await run(["add", "evaluator", "code-based", "--name", "refund_policy", "--level", "SESSION"]);
    const screen = renderScreen("/agentcore/add/evaluator/code-based");
    await reachLambdaStep(screen, "refund_policy");
    await screen.press("down");
    await screen.press("return");
    await screen.write(LAMBDA_ARN);
    await screen.press("return");
    await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "a evaluator with name 'refund_policy' already exists");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this evaluator will be added to agentcore.json");
    expect((await projectSpec(projectRoot)).evaluators).toHaveLength(1);
    screen.unmount();
  }, 20000);
});
