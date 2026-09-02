import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
// The real example, so a test cannot pass against a stale copy of it.
import { COMPONENTS_EXAMPLE } from "./screen";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness(
  "add-config-bundle-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

const COMPONENTS = '{"flags":{"configuration":{"beta":true}}}';

describe("project add config-bundle wizard", () => {
  test("collects a components map and writes the bundle", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    await waitForText(r.lastFrame, "which components does the bundle configure?");
    await r.write(COMPONENTS);
    await r.press("return");

    await waitForText(r.lastFrame, "what is this bundle for?");
    await r.press("return");

    // Branch is prefilled with the flag's default.
    await waitForText(r.lastFrame, "which branch holds the initial configuration?");
    expect(r.lastFrame()).toContain("mainline");
    await r.press("return");

    await waitForText(r.lastFrame, "describe the initial configuration");
    await r.press("return");

    await waitForText(r.lastFrame, "this configuration bundle will be added to agentcore.json");
    // The review names the components rather than reprinting the JSON.
    expect(flatFrame(r.lastFrame)).toContain("components flags");
    await r.press("return");

    await waitForText(r.lastFrame, "added configuration bundle 'runtimeConfig' to 'TestProject'");

    const bundles = (await projectSpec(projectRoot)).configBundles;
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      name: "runtimeConfig",
      components: { flags: { configuration: { beta: true } } },
      branchName: "mainline",
    });
    r.unmount();
  });

  test("malformed components JSON does not advance", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    await waitForText(r.lastFrame, "which components does the bundle configure?");
    await r.write('{"flags":');
    await r.press("return");

    await waitForText(r.lastFrame, "is not valid JSON");
    expect(r.lastFrame()).toContain("which components does the bundle configure?");
    r.unmount();
  });

  test("well-formed JSON of the wrong shape names the offending component", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    await waitForText(r.lastFrame, "which components does the bundle configure?");
    // Parses, but a component maps to an object, not a string.
    await r.write('{"mycomponent": "mycomponent"}');
    await r.press("return");

    // The message carries zod's issue path, so it says *which* key is wrong
    // rather than only that something was the wrong type.
    await waitForFlatText(r.lastFrame, "mycomponent: Invalid input: expected object");
    // The schema rejected it, so the wizard stayed put rather than advancing.
    expect(r.lastFrame()).toContain("which components does the bundle configure?");
    expect(r.lastFrame()).not.toContain("what is this bundle for?");
    r.unmount();
  });

  test("the example stays on screen while the user types over it", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    // A placeholder would vanish on the first keystroke; the example must not,
    // because that is when the shape is most needed.
    await waitForText(r.lastFrame, "which components does the bundle configure?");
    expect(r.lastFrame()).toContain(`for example  ${COMPONENTS_EXAMPLE}`);

    await r.write('{"pri');
    expect(r.lastFrame()).toContain(`for example  ${COMPONENTS_EXAMPLE}`);
    r.unmount();
  });

  test("the example is itself a value the step accepts", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    await waitForText(r.lastFrame, "which components does the bundle configure?");
    await r.write(COMPONENTS_EXAMPLE);
    await r.press("return");

    // Advancing proves the example parses and satisfies the schema — an example
    // that does not work is worse than none.
    await waitForText(r.lastFrame, "what is this bundle for?");
    await r.press("return");
    await waitForText(r.lastFrame, "which branch holds the initial configuration?");
    await r.press("return");
    await waitForText(r.lastFrame, "describe the initial configuration");
    await r.press("return");
    await waitForText(r.lastFrame, "this configuration bundle will be added to agentcore.json");
    await r.press("return");

    await waitForText(r.lastFrame, "added configuration bundle 'runtimeConfig'");
    expect((await projectSpec(projectRoot)).configBundles[0].components).toEqual({
      pricing: { configuration: { currency: "USD" } },
    });
    r.unmount();
  });

  test("an empty components map is refused", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    await waitForText(r.lastFrame, "which components does the bundle configure?");
    await r.press("return");

    await waitForText(r.lastFrame, "component configuration map is required");
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("1-bad-name");
    await r.press("return");

    await waitForText(r.lastFrame, "Must begin with a letter");
    r.unmount();
  });
});
