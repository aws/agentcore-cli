import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness(
  "add-online-insight-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add online-insight wizard", () => {
  test("writes the same config the flag path writes, with clustering", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/online-insight");

    await waitForText(r.lastFrame, "what should this online insight config be called?");
    await r.write("prod_failures");
    await r.press("return");

    await waitForText(r.lastFrame, "what should this insight config monitor?");
    await r.press("return");
    await waitForText(r.lastFrame, "which agent's traffic should be sampled?");
    await r.press("return");
    await waitForText(r.lastFrame, "scope to one endpoint?");
    await r.write("PROD");
    await r.press("return");

    await waitForText(r.lastFrame, "which insights should be generated?");
    await r.write("Builtin.Insight.FailureAnalysis");
    await r.press("return");

    await waitForText(r.lastFrame, "how often should sessions be clustered?");
    await r.write(" ");
    await r.press("down");
    await r.press("down");
    await r.write(" ");
    await r.press("return");

    await waitForText(r.lastFrame, "what share of sessions should be sampled?");
    await r.write("50");
    await r.press("return");
    await waitForText(r.lastFrame, "should insight start when this deploys?");
    await r.press("return");
    await waitForText(r.lastFrame, "what is this config for?");
    await r.write("watch for failures");
    await r.press("return");

    await waitForText(r.lastFrame, "this config will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("agent hello_world (PROD)");
    expect(review).toContain("clustering DAILY, MONTHLY");
    await r.press("return");

    await waitForText(r.lastFrame, "added online-insight config 'prod_failures'");

    expect((await projectSpec(projectRoot)).onlineEvalConfigs).toEqual([
      {
        name: "prod_failures",
        agent: "hello_world",
        endpoint: "PROD",
        insights: ["Builtin.Insight.FailureAnalysis"],
        clusteringConfig: { frequencies: ["DAILY", "MONTHLY"] },
        samplingRate: 50,
        description: "watch for failures",
        enableOnCreate: true,
      },
    ]);
    r.unmount();
  });

  test("an insight that is neither Builtin.Insight.* nor an ARN is refused", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/online-insight");

    await waitForText(r.lastFrame, "what should this online insight config be called?");
    await r.write("x");
    await r.press("return");
    await waitForText(r.lastFrame, "what should this insight config monitor?");
    await r.press("return");
    await waitForText(r.lastFrame, "which agent's traffic should be sampled?");
    await r.press("return");
    await waitForText(r.lastFrame, "scope to one endpoint?");
    await r.press("return");

    await waitForText(r.lastFrame, "which insights should be generated?");
    await r.write("Builtin.Helpfulness");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "must be a Builtin.Insight.* identifier or a full ARN");
    expect(r.lastFrame()).toContain("which insights should be generated?");
    r.unmount();
  });
});
