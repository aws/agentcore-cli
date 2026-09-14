import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
} from "../../../../testing";
import { createRootHandler } from "../../../index";
import { InputValidationError } from "../../../../errors";
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
    // The components step is a textarea, so enter is a newline and ctrl+d moves on.
    await r.press("ctrl+d");

    // Branch is prefilled with the flag's default.
    await waitForText(r.lastFrame, "which branch holds the initial configuration?");
    expect(r.lastFrame()).toContain("mainline");
    await r.press("return");

    await waitForText(r.lastFrame, "describe the initial configuration");
    await r.press("return");

    await waitForText(r.lastFrame, "this configuration bundle will be added to agentcore.json");
    // The review names the components rather than reprinting the JSON, and says
    // what the skipped commit message step left behind.
    expect(flatFrame(r.lastFrame)).toContain("components flags");
    expect(flatFrame(r.lastFrame)).toContain("commit message (none)");
    await r.press("return");

    await waitForText(r.lastFrame, "added configuration bundle 'runtimeConfig' to 'TestProject'");
    expect(r.lastFrame()).toContain("[enter] go back");

    const bundles = (await projectSpec(projectRoot)).configBundles;
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      name: "runtimeConfig",
      components: { flags: { configuration: { beta: true } } },
      branchName: "mainline",
    });
    // A skipped step stays unset rather than being written as an empty string,
    // and the wizard never asks for a description, so it is absent too.
    expect(bundles[0].description).toBeUndefined();
    expect(bundles[0].commitMessage).toBeUndefined();

    // Enter on the success panel returns to the add menu instead of tearing the
    // TUI down, so another resource can be added straight away.
    await r.press("return");
    await waitForText(r.lastFrame, "add project resources");
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
    await r.press("ctrl+d");

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
    await r.press("ctrl+d");

    // The message carries zod's issue path, so it says *which* key is wrong
    // rather than only that something was the wrong type.
    await waitForFlatText(r.lastFrame, "mycomponent: Invalid input: expected object");
    // The schema rejected it, so the wizard stayed put rather than advancing.
    expect(r.lastFrame()).toContain("which components does the bundle configure?");
    expect(r.lastFrame()).not.toContain("which branch holds the initial configuration?");
    r.unmount();
  });

  test("enter adds a line to the components map instead of advancing", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write("runtimeConfig");
    await r.press("return");

    // A components map usually arrives pretty-printed, so the step has to hold a
    // value typed or pasted over several lines.
    await waitForText(r.lastFrame, "which components does the bundle configure?");
    await r.write("{");
    await r.press("return");
    await r.write('"flags": {"configuration": {"beta": true}}');
    await r.press("return");
    await r.write("}");
    expect(r.lastFrame()).toContain("which components does the bundle configure?");

    await r.press("ctrl+d");
    await waitForText(r.lastFrame, "which branch holds the initial configuration?");
    await r.press("return");
    await r.press("return");
    await waitForText(r.lastFrame, "this configuration bundle will be added to agentcore.json");
    await r.press("return");

    await waitForText(r.lastFrame, "added configuration bundle 'runtimeConfig'");
    expect((await projectSpec(projectRoot)).configBundles[0].components).toEqual({
      flags: { configuration: { beta: true } },
    });
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
    await r.press("ctrl+d");

    // Advancing proves the example parses and satisfies the schema — an example
    // that does not work is worse than none.
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
    await r.press("ctrl+d");

    await waitForText(r.lastFrame, "component configuration map is required");
    r.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    // No enter: the name is checked while it is being typed, so the rule is
    // stated before the user has finished getting it wrong.
    await r.write("1-bad-name");

    await waitForText(r.lastFrame, "Must begin with a letter");
    r.unmount();
  });

  test("a name that is only valid once trimmed is refused, not silently trimmed", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.write(" runtimeConfig ");
    await r.press("return");

    // Still on the name step: the value the step would submit is the value it
    // checked, so a padded name cannot reach the project spec.
    await waitForText(r.lastFrame, "Must begin with a letter");
    expect(r.lastFrame()).not.toContain("which components does the bundle configure?");
    expect((await projectSpec(projectRoot)).configBundles ?? []).toHaveLength(0);
    r.unmount();
  });

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const r = renderScreen("/agentcore/project/add/config-bundle");

    await waitForText(r.lastFrame, "what should this configuration bundle be called?");
    await r.press("escape");

    await waitForText(r.lastFrame, "add project resources");
    r.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: config-bundle has to be one of
// the resources a bare `project add <resource>` opens a wizard for, and
// everything else has to stay headless.
describe("project add config-bundle dispatch", () => {
  function buildRoot(io: Parameters<typeof createRootHandler>[1]["io"]) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  test("bare add config-bundle in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    // outcome never rejects, so a mid-pump failure cannot trip bun's
    // unhandled-rejection detection before the final assertion.
    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "project", "add", "config-bundle"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The wizard never finishes on its own; Ctrl+C (re-sent until the app
    // reacts) closes it and resolves the route cleanly. The headless branch
    // would instead reject with the missing --name usage error.
    await waitFor(
      () => {
        if (!settled) stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(streams.stderr()).not.toContain("required option");
  }, 10000);

  test("bare add config-bundle without a TTY stays headless", async () => {
    await inProject();

    const error = await buildRoot(testIO().io)
      .route(["node", "agentcore", "project", "add", "config-bundle"])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name <name>' not specified");
  });

  // --name alone is not a bare command, so it must not open the wizard either:
  // the flag path still owns the whole input, and it still requires components.
  test("add config-bundle with a name but no components is rejected", async () => {
    await inProject();

    const error = await buildRoot(testIO().io)
      .route(["node", "agentcore", "project", "add", "config-bundle", "--name", "runtimeConfig"])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(
      "required option '--components <components>' not specified",
    );
  });
});
