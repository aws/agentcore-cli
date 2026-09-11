import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
  type RenderScreenResult,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness("add-runtime-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

// selectTemplate moves the choice list onto a named template rather than
// pressing a fixed number of arrows, so adding or reordering a template does
// not silently point this test at a different one.
async function selectTemplate(r: RenderScreenResult, template: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    // The trailing space keeps a name from matching a longer one that starts
    // with it — agent-python-strands against agent-python-strands-container.
    if (flatFrame(r.lastFrame).includes(`● ${template} `)) return;
    await r.press("up");
  }
  throw new Error(`template ${template} was never selected`);
}

async function runtimeInSpec(projectRoot: string, name: string) {
  const spec = await projectSpec(projectRoot);
  return spec.runtimes.find((candidate: { name: string }) => candidate.name === name);
}

describe("project add runtime wizard", () => {
  test("collects a name, template and description, then writes the runtime", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("orders_agent");
    await r.press("return");

    // The default template is the one the flag path scaffolds without --template.
    await waitForText(r.lastFrame, "choose a template");
    expect(flatFrame(r.lastFrame)).toContain("● agent-python-minimal ");
    await r.press("return");

    await waitForText(r.lastFrame, "what is this runtime for?");
    await r.write("answers questions about orders");
    await r.press("return");

    await waitForText(r.lastFrame, "this runtime will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("runtime orders_agent");
    expect(review).toContain("template agent-python-minimal");
    expect(review).toContain("description answers questions about orders");
    await r.press("return");

    await waitForText(r.lastFrame, "added runtime 'orders_agent' to 'TestProject'");

    expect(await runtimeInSpec(projectRoot, "orders_agent")).toMatchObject({
      description: "answers questions about orders",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/orders_agent",
      runtimeVersion: "PYTHON_3_14",
    });
    expect(await Bun.file(join(projectRoot, "app", "orders_agent", "main.py")).exists()).toBe(true);
    r.unmount();
  });

  test("scaffolds the template the user picks", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.write("packing_agent");
    await r.press("return");

    await waitForText(r.lastFrame, "choose a template");
    await selectTemplate(r, "agent-python-strands-container");
    await r.press("return");

    // The description is optional, so a blank answer advances.
    await waitForText(r.lastFrame, "what is this runtime for?");
    await r.press("return");

    await waitForFlatText(r.lastFrame, "build Container");
    await r.press("return");

    await waitForText(r.lastFrame, "added runtime 'packing_agent' to 'TestProject'");

    const runtime = await runtimeInSpec(projectRoot, "packing_agent");
    expect(runtime).toMatchObject({ build: "Container", codeLocation: "app/packing_agent" });
    expect(runtime.description).toBeUndefined();
    expect(await Bun.file(join(projectRoot, "app", "packing_agent", "Dockerfile")).exists()).toBe(
      true,
    );
    r.unmount();
  });

  test("a blank name is refused", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.press("return");

    await waitForText(r.lastFrame, "Name is required");
    expect(r.lastFrame()).not.toContain("choose a template");
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    // No enter: the name is checked while it is being typed, so the rule is
    // stated before the user has finished getting it wrong.
    await r.write("1agent");

    await waitForText(r.lastFrame, "Must begin with a letter");
    r.unmount();
  });

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/runtime");

    await waitForText(r.lastFrame, "what should this runtime be called?");
    await r.press("escape");

    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });
});
