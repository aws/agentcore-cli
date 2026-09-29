import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupScreens,
  flatFrame,
  renderScreen,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec, writeProjectSpec } =
  createGatewayProjectTestHarness("add-online-eval-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

const PROJECT_EVALUATOR = {
  name: "quality",
  level: "SESSION",
  config: {
    llmAsAJudge: {
      model: "amazon.nova-lite-v1:0",
      instructions: "Judge the response quality",
      ratingScale: {
        categorical: [
          { label: "Pass", definition: "The response satisfies the request" },
          { label: "Fail", definition: "The response does not satisfy the request" },
        ],
      },
    },
  },
};

async function finishSampling(screen: RenderScreenResult, samplingRate = "10"): Promise<void> {
  await waitForText(screen.lastFrame, "what percentage of sessions should be sampled?");
  await screen.write(samplingRate);
  await screen.press("return");
}

describe("project add online-eval wizard", () => {
  test("adds a Runtime-backed config using a project evaluator", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.evaluators = [PROJECT_EVALUATOR];
    await writeProjectSpec(projectRoot, spec);
    const screen = renderScreen("/agentcore/add/online-eval");

    await waitForText(screen.lastFrame, "what should this online evaluation config be called?");
    await screen.write("production_quality");
    await screen.press("return");

    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    expect(screen.lastFrame()).toContain("❯ ● project Runtime");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    expect(screen.lastFrame()).toContain("❯ ● agent");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which evaluators should score it?");
    expect(screen.lastFrame()).toContain("quality");
    expect(screen.lastFrame()).toContain("SESSION project evaluator");
    expect(screen.lastFrame()).toContain("Builtin.Correctness");
    await screen.write(" ");
    await screen.press("return");
    await finishSampling(screen, "12.5");

    await waitForText(
      screen.lastFrame,
      "this online evaluation config will be added to agentcore.json",
    );
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("source agent:DEFAULT");
    expect(review).toContain("evaluators quality");
    expect(review).toContain("sampling 12.5%");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added online-eval config 'production_quality' to 'TestProject'",
    );
    expect((await projectSpec(projectRoot)).onlineEvalConfigs).toContainEqual({
      name: "production_quality",
      agent: "agent",
      evaluators: ["quality"],
      samplingRate: 12.5,
    });
    screen.unmount();
  });

  test("adds a custom-log config using a built-in evaluator", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/online-eval");

    await waitForText(screen.lastFrame, "what should this online evaluation config be called?");
    await screen.write("custom_quality");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which CloudWatch log groups contain the sessions?");
    await screen.write("/aws/example/one, /aws/example/two");
    await screen.press("return");
    await waitForText(screen.lastFrame, "limit traces to particular service names?");
    await screen.write("checkout, inventory");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which evaluators should score it?");
    expect(screen.lastFrame()).toContain("Builtin.Correctness");
    await screen.write(" ");
    await screen.press("return");
    await finishSampling(screen, "0.5");

    await waitForText(
      screen.lastFrame,
      "this online evaluation config will be added to agentcore.json",
    );
    await screen.press("return");
    await waitForText(screen.lastFrame, "added online-eval config 'custom_quality'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs).toContainEqual({
      name: "custom_quality",
      logGroupNames: ["/aws/example/one", "/aws/example/two"],
      serviceNames: ["checkout", "inventory"],
      evaluators: ["Builtin.Correctness"],
      samplingRate: 0.5,
    });
    screen.unmount();
  });

  test("offers named endpoints for the selected project Runtime", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.runtimes[0].endpoints = { PROD: { version: 1 } };
    await writeProjectSpec(projectRoot, spec);
    const screen = renderScreen("/agentcore/add/online-eval");

    await waitForText(screen.lastFrame, "what should this online evaluation config be called?");
    await screen.write("endpoint_quality");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which Runtime endpoint should be monitored?");
    expect(screen.lastFrame()).toContain("NO ENDPOINT (default)");
    expect(screen.lastFrame()).toContain("PROD");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which evaluators should score it?");
    await screen.write(" ");
    await screen.press("return");
    await finishSampling(screen);
    await waitForText(
      screen.lastFrame,
      "this online evaluation config will be added to agentcore.json",
    );
    expect(flatFrame(screen.lastFrame)).toContain("source agent:PROD");
    await screen.press("return");
    await waitForText(screen.lastFrame, "added online-eval config 'endpoint_quality'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs[0]).toMatchObject({
      agent: "agent",
      endpoint: "PROD",
    });
    screen.unmount();
  });

  test("requires at least one evaluator", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/online-eval");

    await waitForText(screen.lastFrame, "what should this online evaluation config be called?");
    await screen.write("required_evaluator");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which evaluators should score it?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Select at least one evaluator");
    expect(screen.lastFrame()).toContain("which evaluators should score it?");
    screen.unmount();
  });

  test("validates decimal sampling rates against the service range", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/online-eval");

    await waitForText(screen.lastFrame, "what should this online evaluation config be called?");
    await screen.write("sampled_quality");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which evaluators should score it?");
    await screen.write(" ");
    await screen.press("return");
    await finishSampling(screen, "0.001");

    await waitForText(screen.lastFrame, ">=0.01");
    expect(screen.lastFrame()).toContain("what percentage of sessions should be sampled?");
    screen.unmount();
  });

  test("validates the deployed name against the longest project target", async () => {
    const projectRoot = await inProject();
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([
        {
          name: "production",
          account: "111122223333",
          region: "us-east-1",
        },
      ]),
    );
    const screen = renderScreen("/agentcore/add/online-eval");

    await waitForText(screen.lastFrame, "what should this online evaluation config be called?");
    await screen.write(`a${"x".repeat(25)}`);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "is 49 characters. The maximum is 48.");
    expect(flatFrame(screen.lastFrame)).toContain("TestProject_production_");
    expect(screen.lastFrame()).toContain("what should this online evaluation config be called?");
    screen.unmount();
  });
});
