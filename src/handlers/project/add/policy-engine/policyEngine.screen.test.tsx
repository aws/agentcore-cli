import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { addGateway, cleanup, inProject, projectSpec } = createGatewayProjectTestHarness(
  "add-policy-engine-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add policy-engine wizard", () => {
  test("skips the attach step when the project has no Gateways", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/policy-engine");

    await waitForText(r.lastFrame, "what should this Policy Engine be called?");
    // Nothing to attach to, so the stepper offers name → description → review.
    expect(r.lastFrame()).toContain("○ review");
    expect(r.lastFrame()).not.toContain("attach");
    await r.write("Guardrails");
    await r.press("return");

    await waitForText(r.lastFrame, "what does this engine govern?");
    await r.press("return");

    await waitForText(r.lastFrame, "this Policy Engine will be added to agentcore.json");
    expect(r.lastFrame()).toContain("none");
    await r.press("return");

    await waitForText(r.lastFrame, "added Policy Engine 'Guardrails' to 'TestProject'");

    const engines = (await projectSpec(projectRoot)).policyEngines;
    expect(engines).toHaveLength(1);
    expect(engines[0]).toMatchObject({ name: "Guardrails" });
    r.unmount();
  });

  test("offers the project's Gateways, and the mode step only once one is picked", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    const r = renderScreen("/agentcore/project/add/policy-engine");

    await waitForText(r.lastFrame, "what should this Policy Engine be called?");
    await r.write("Guardrails");
    await r.press("return");

    await waitForText(r.lastFrame, "what does this engine govern?");
    await r.press("return");

    // The attach step lists the Gateway the project already declares.
    await waitForText(r.lastFrame, "which Gateways should this engine govern?");
    expect(r.lastFrame()).toContain("tools");
    // Nothing is selected yet, so the mode step is not in the flow.
    expect(r.lastFrame()).not.toContain("○ mode");

    await r.write(" ");
    await waitForText(r.lastFrame, "○ mode");
    await r.press("return");

    await waitForText(r.lastFrame, "how should the attached Gateways enforce this engine?");
    expect(r.lastFrame()).toContain("● enforce (default)");
    // log-only is the second row.
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "this Policy Engine will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("attached gateways tools");
    expect(review).toContain("mode log-only");
    await r.press("return");

    await waitForText(r.lastFrame, "added Policy Engine 'Guardrails'");

    const spec = await projectSpec(projectRoot);
    expect(spec.policyEngines[0]).toMatchObject({ name: "Guardrails" });
    // The attachment is recorded on the Gateway, as the handler records it.
    expect(spec.agentCoreGateways[0].policyEngineConfiguration).toEqual({
      policyEngineName: "Guardrails",
      mode: "LOG_ONLY",
    });
    r.unmount();
  });

  test("a name that would exceed the service limit is rejected", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/policy-engine");

    await waitForText(r.lastFrame, "what should this Policy Engine be called?");
    await r.write("a".repeat(40));
    await r.press("return");

    await waitForFlatText(r.lastFrame, "exceeds the service limit of 48 characters");
    expect(flatFrame(r.lastFrame)).toContain("what should this Policy Engine be called?");
    r.unmount();
  });
});
