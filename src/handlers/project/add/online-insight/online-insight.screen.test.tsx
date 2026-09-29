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

const { cleanup, inProject, projectSpec, writeProjectSpec } = createGatewayProjectTestHarness(
  "add-online-insight-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function chooseFailureAnalysis(screen: RenderScreenResult): Promise<void> {
  await waitForText(screen.lastFrame, "which built-in insights should be produced?");
  await screen.write(" ");
  await screen.press("return");
  await waitForText(screen.lastFrame, "add any other insight identifiers?");
  await screen.press("return");
}

async function finishDefaults(screen: RenderScreenResult, samplingRate = "10"): Promise<void> {
  await waitForText(screen.lastFrame, "how often should insight clusters be generated?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what percentage of sessions should be sampled?");
  await screen.write(samplingRate);
  await screen.press("return");
  await waitForText(screen.lastFrame, "describe this config's monitoring purpose");
  await screen.press("return");
  await waitForText(screen.lastFrame, "enable this config when it is deployed?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "add tags to this online insight config?");
  await screen.press("return");
}

describe("project add online-insight wizard", () => {
  test("adds a Runtime-backed config with the wizard's advanced inputs", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/online-insight");

    await waitForText(screen.lastFrame, "what should this online insight config be called?");
    await screen.write("production_insights");
    await screen.press("return");

    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    expect(screen.lastFrame()).toContain("❯ ● project Runtime");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    expect(screen.lastFrame()).toContain("❯ ● agent");
    await screen.press("return");

    await chooseFailureAnalysis(screen);

    await waitForText(screen.lastFrame, "how often should insight clusters be generated?");
    await screen.write(" ");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what percentage of sessions should be sampled?");
    await screen.write("12.5");
    await screen.press("return");

    await waitForText(screen.lastFrame, "describe this config's monitoring purpose");
    await screen.write("Monitor production sessions");
    await screen.press("return");

    await waitForText(screen.lastFrame, "enable this config when it is deployed?");
    expect(screen.lastFrame()).toContain("● enabled (default)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "add tags to this online insight config?");
    await screen.write("team=checkout, environment=production");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "this online insight config will be added to agentcore.json",
    );
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("source agent:DEFAULT");
    expect(review).toContain("insights Builtin.Insight.FailureAnalysis");
    expect(review).toContain("clustering DAILY");
    expect(review).toContain("sampling 12.5%");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added online-insight config 'production_insights' to 'TestProject'",
    );
    expect((await projectSpec(projectRoot)).onlineEvalConfigs).toContainEqual({
      name: "production_insights",
      agent: "agent",
      insights: ["Builtin.Insight.FailureAnalysis"],
      clusteringConfig: { frequencies: ["DAILY"] },
      samplingRate: 12.5,
      description: "Monitor production sessions",
      tags: { team: "checkout", environment: "production" },
    });
    screen.unmount();
  });

  test("adds a custom-log config with services, custom insights, clustering, and paused state", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/online-insight");

    await waitForText(screen.lastFrame, "what should this online insight config be called?");
    await screen.write("custom_logs");
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

    await waitForText(screen.lastFrame, "which built-in insights should be produced?");
    await screen.press("down");
    await screen.write(" ");
    await screen.press("return");

    await waitForText(screen.lastFrame, "add any other insight identifiers?");
    await screen.write("arn:aws:bedrock-agentcore:us-east-1:111122223333:insight/custom");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how often should insight clusters be generated?");
    await screen.write(" ");
    await screen.press("down");
    await screen.write(" ");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what percentage of sessions should be sampled?");
    await screen.write("0.5");
    await screen.press("return");
    await waitForText(screen.lastFrame, "describe this config's monitoring purpose");
    await screen.press("return");

    await waitForText(screen.lastFrame, "enable this config when it is deployed?");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "add tags to this online insight config?");
    await screen.write('{"owner":"observability"}');
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "this online insight config will be added to agentcore.json",
    );
    await screen.press("return");
    await waitForText(screen.lastFrame, "added online-insight config 'custom_logs'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs).toContainEqual({
      name: "custom_logs",
      logGroupNames: ["/aws/example/one", "/aws/example/two"],
      serviceNames: ["checkout", "inventory"],
      insights: [
        "Builtin.Insight.UserIntent",
        "arn:aws:bedrock-agentcore:us-east-1:111122223333:insight/custom",
      ],
      clusteringConfig: { frequencies: ["DAILY", "WEEKLY"] },
      samplingRate: 0.5,
      enableOnCreate: false,
      tags: { owner: "observability" },
    });
    screen.unmount();
  });

  test("offers named endpoints for the selected project Runtime", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.runtimes[0].endpoints = { PROD: { version: 1 } };
    await writeProjectSpec(projectRoot, spec);
    const screen = renderScreen("/agentcore/add/online-insight");

    await waitForText(screen.lastFrame, "what should this online insight config be called?");
    await screen.write("endpoint_insights");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which Runtime endpoint should be monitored?");
    expect(screen.lastFrame()).toContain("DEFAULT (default)");
    expect(screen.lastFrame()).toContain("PROD");
    await screen.press("down");
    await screen.press("return");

    await chooseFailureAnalysis(screen);
    await finishDefaults(screen);
    await waitForText(
      screen.lastFrame,
      "this online insight config will be added to agentcore.json",
    );
    expect(flatFrame(screen.lastFrame)).toContain("source agent:PROD");
    await screen.press("return");
    await waitForText(screen.lastFrame, "added online-insight config 'endpoint_insights'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs[0]).toMatchObject({
      agent: "agent",
      endpoint: "PROD",
    });
    screen.unmount();
  });

  test("requires either a built-in or custom insight identifier", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/online-insight");

    await waitForText(screen.lastFrame, "what should this online insight config be called?");
    await screen.write("required_insight");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which built-in insights should be produced?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "add any other insight identifiers?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Insight identifiers is required");
    expect(screen.lastFrame()).toContain("add any other insight identifiers?");
    screen.unmount();
  });

  test("validates decimal sampling rates against the service range", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/online-insight");

    await waitForText(screen.lastFrame, "what should this online insight config be called?");
    await screen.write("sampled_insights");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where should sessions be sampled from?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime should be monitored?");
    await screen.press("return");
    await chooseFailureAnalysis(screen);
    await waitForText(screen.lastFrame, "how often should insight clusters be generated?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what percentage of sessions should be sampled?");
    await screen.write("0.001");
    await screen.press("return");

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
    const screen = renderScreen("/agentcore/add/online-insight");

    await waitForText(screen.lastFrame, "what should this online insight config be called?");
    await screen.write(`a${"x".repeat(25)}`);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "is 49 characters. The maximum is 48.");
    expect(flatFrame(screen.lastFrame)).toContain("TestProject_production_");
    expect(screen.lastFrame()).toContain("what should this online insight config be called?");
    screen.unmount();
  });
});
