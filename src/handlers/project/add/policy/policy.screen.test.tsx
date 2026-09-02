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
  createGatewayProjectTestHarness("add-policy-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

const FORBID_ALL = "forbid(principal, action, resource);";

describe("project add policy wizard", () => {
  test("names the missing Policy Engine when the project has none", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/policy");

    await waitForText(r.lastFrame, "has no Policy Engines yet");
    expect(r.lastFrame()).toContain("agentcore project add policy-engine");

    await r.press("escape");
    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });

  test("writes the same Policy the flag path writes, with the phase inferred", async () => {
    const projectRoot = await inProject();
    await run(["add", "policy-engine", "--name", "Guardrails"]);
    const r = renderScreen("/agentcore/project/add/policy");

    await waitForText(r.lastFrame, "which Policy Engine should hold this Policy?");
    expect(r.lastFrame()).toContain("● Guardrails");
    await r.press("return");

    await waitForText(r.lastFrame, "what should this Policy be called?");
    await r.write("DenyAll");
    await r.press("return");

    await waitForText(r.lastFrame, "paste the Cedar statement");
    await r.write(FORBID_ALL);
    await r.write("\x04");

    await waitForText(r.lastFrame, "when should this Policy be evaluated?");
    await r.press("return");
    await waitForText(r.lastFrame, "what should happen if the validator flags the statement?");
    await r.press("return");
    await waitForText(r.lastFrame, "how should this Policy be enforced?");
    await r.press("return");
    await waitForText(r.lastFrame, "what does this Policy do?");
    await r.press("return");

    await waitForText(r.lastFrame, "this Policy will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("policy DenyAll");
    expect(review).toContain("engine Guardrails");
    expect(review).toContain("phase INITIATE (inferred)");
    await r.press("return");

    await waitForText(r.lastFrame, "added Policy 'DenyAll' to Policy Engine 'Guardrails'");

    const policies = (await projectSpec(projectRoot)).policyEngines[0].policies;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      name: "DenyAll",
      statement: FORBID_ALL,
      authorizationPhase: "INITIATE",
      validationMode: "FAIL_ON_ANY_FINDINGS",
      enforcementMode: "ACTIVE",
    });
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected", async () => {
    await inProject();
    await run(["add", "policy-engine", "--name", "Guardrails"]);
    const r = renderScreen("/agentcore/project/add/policy");

    await waitForText(r.lastFrame, "which Policy Engine should hold this Policy?");
    await r.press("return");
    await waitForText(r.lastFrame, "what should this Policy be called?");
    await r.write("bad-name");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "Must begin with a letter");
    expect(r.lastFrame()).toContain("what should this Policy be called?");
    r.unmount();
  });
});
