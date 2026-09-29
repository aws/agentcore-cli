import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  waitForFlatText,
  waitForText,
  type RenderScreenResult,
} from "../../../../testing";
import { createRootHandler } from "../../../index";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
// The real example, so a test cannot pass against a stale copy of it.
import { COMPONENTS_EXAMPLE } from "./screen";

const { cleanup, inProject, projectSpec, run } = createGatewayProjectTestHarness(
  "add-config-bundle-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

const COMPONENTS = '{"flags":{"configuration":{"beta":true}}}';

async function bundlesOf(projectRoot: string) {
  return (await projectSpec(projectRoot)).configBundles ?? [];
}

// reachComponentsStep answers the name step, leaving the wizard on the
// components step: where every test about the map starts.
async function reachComponentsStep(screen: RenderScreenResult, name = "runtimeConfig") {
  await waitForText(screen.lastFrame, "what should this configuration bundle be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "which components does the bundle configure?");
}

describe("project add config-bundle wizard", () => {
  test("collects a components map and writes the same bundle as the flags", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");

    await reachComponentsStep(screen);
    expect(screen.lastFrame()).toContain("[enter] newline");
    expect(screen.lastFrame()).toContain("[ctrl+d] continue");
    await screen.write(COMPONENTS);
    // The components step is a textarea, so enter is a newline and ctrl+d moves on.
    await screen.press("ctrl+d");

    // Branch and commit message share a step. The branch is prefilled with the
    // flag's default; enter moves down to the message, and enter again continues.
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");
    expect(screen.lastFrame()).toContain("❯ mainline");
    expect(screen.lastFrame()).toContain("Commit message");
    await screen.press("return");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "this configuration bundle will be added to agentcore.json",
    );
    // The review names the components rather than reprinting the JSON, and says
    // what the skipped commit step left behind.
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("bundle runtimeConfig");
    expect(review).toContain("components flags");
    expect(review).toContain("branch mainline");
    expect(review).toContain("commit message (none)");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added configuration bundle 'runtimeConfig' to 'TestProject'",
    );
    expect(screen.lastFrame()).toContain("[enter] go back");

    const bundles = await bundlesOf(projectRoot);
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

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("a branch and a commit message are written as typed", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");

    await reachComponentsStep(screen, "featureFlags");
    await screen.write(COMPONENTS);
    await screen.press("ctrl+d");

    // The prefilled default typed over: mainline → mainline/eu.
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");
    await screen.write("/eu");
    await screen.press("return");
    await screen.write("initial flags");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "branch mainline/eu");
    expect(flatFrame(screen.lastFrame)).toContain("commit message initial flags");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added configuration bundle 'featureFlags'");
    expect((await bundlesOf(projectRoot))[0]).toMatchObject({
      branchName: "mainline/eu",
      commitMessage: "initial flags",
    });
    screen.unmount();
  }, 15000);

  test("an invalid branch name keeps the step", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);
    await screen.write(COMPONENTS);
    await screen.press("ctrl+d");
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");

    // The prefilled mainline typed out to "mainline x": a space breaks the pattern.
    await screen.write(" x");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Value must match");
    expect(screen.lastFrame()).toContain("how should the initial configuration be recorded?");
    screen.unmount();
  });

  test("a branch skipped with the arrows is still checked on the last enter", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);
    await screen.write(COMPONENTS);
    await screen.press("ctrl+d");
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");

    await screen.write(" x");
    await screen.press("down");
    await screen.write("note");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Value must match");
    expect(screen.lastFrame()).not.toContain("this configuration bundle will be added");
    screen.unmount();
  });

  test("malformed components JSON does not advance", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);

    await screen.write('{"flags":');
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "is not valid JSON");
    expect(screen.lastFrame()).toContain("which components does the bundle configure?");
    screen.unmount();
  });

  test("well-formed JSON of the wrong shape names the offending component", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);

    // Parses, but a component maps to an object, not a string.
    await screen.write('{"mycomponent": "mycomponent"}');
    await screen.press("ctrl+d");

    // The message carries zod's issue path, so it says which key is wrong
    // rather than only that something was the wrong type.
    await waitForFlatText(screen.lastFrame, "mycomponent: Invalid input: expected object");
    expect(screen.lastFrame()).toContain("which components does the bundle configure?");
    expect(screen.lastFrame()).not.toContain("how should the initial configuration be recorded?");
    screen.unmount();
  });

  test("enter adds a line to the components map instead of advancing", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);

    // A components map usually arrives pretty-printed, so the step has to hold a
    // value typed or pasted over several lines.
    await screen.write("{");
    await screen.press("return");
    await screen.write('"flags": {"configuration": {"beta": true}}');
    await screen.press("return");
    await screen.write("}");
    expect(screen.lastFrame()).toContain("which components does the bundle configure?");

    await screen.press("ctrl+d");
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");
    await screen.press("return");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "this configuration bundle will be added to agentcore.json",
    );
    await screen.press("return");

    await waitForText(screen.lastFrame, "added configuration bundle 'runtimeConfig'");
    expect((await bundlesOf(projectRoot))[0].components).toEqual({
      flags: { configuration: { beta: true } },
    });
    screen.unmount();
  }, 15000);

  test("the example stays on screen while the user types over it", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);

    // A placeholder would vanish on the first keystroke; the example must not,
    // because that is when the shape is most needed.
    expect(screen.lastFrame()).toContain(`for example  ${COMPONENTS_EXAMPLE}`);
    await screen.write('{"pri');
    expect(screen.lastFrame()).toContain(`for example  ${COMPONENTS_EXAMPLE}`);
    screen.unmount();
  });

  test("the example is itself a value the step accepts", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);

    await screen.write(COMPONENTS_EXAMPLE);
    await screen.press("ctrl+d");

    // Advancing proves the example parses and satisfies the schema — an example
    // that does not work is worse than none.
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");
    await screen.press("return");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "this configuration bundle will be added to agentcore.json",
    );
    await screen.press("return");

    await waitForText(screen.lastFrame, "added configuration bundle 'runtimeConfig'");
    expect((await bundlesOf(projectRoot))[0].components).toEqual({
      pricing: { configuration: { currency: "USD" } },
    });
    screen.unmount();
  }, 15000);

  test("an empty components map is refused", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);

    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "Component configuration map is required");
    screen.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");

    await waitForText(screen.lastFrame, "what should this configuration bundle be called?");
    await screen.write("1-bad-name");

    await waitForText(screen.lastFrame, "Must begin with a letter");
    screen.unmount();
  });

  test("validates the deployed name against the longest project target", async () => {
    const projectRoot = await inProject();
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "production", account: "111122223333", region: "us-east-1" }]),
    );
    // 78 characters: legal on its own, one over once the project and the target
    // are prefixed.
    const name = `c${"x".repeat(77)}`;
    const screen = renderScreen("/agentcore/add/config-bundle");

    await waitForText(screen.lastFrame, "what should this configuration bundle be called?");
    await screen.write(name);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "is 101 characters. The maximum is 100.");
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain("TestProject_production_");
    expect(frame).toContain("what should this configuration bundle be called?");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    // The name is taken, so addResource refuses it — the realistic failure, and
    // one the user can fix without retyping the components map.
    await run(["add", "config-bundle", "--name", "runtimeConfig", "--components", COMPONENTS]);
    const screen = renderScreen("/agentcore/add/config-bundle");
    await reachComponentsStep(screen);
    await screen.write(COMPONENTS);
    await screen.press("ctrl+d");
    await waitForText(screen.lastFrame, "how should the initial configuration be recorded?");
    await screen.press("return");
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "this configuration bundle will be added to agentcore.json",
    );
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "already exists");
    await screen.press("escape");
    await waitForText(
      screen.lastFrame,
      "this configuration bundle will be added to agentcore.json",
    );
    expect(flatFrame(screen.lastFrame)).toContain("components flags");

    expect(await bundlesOf(projectRoot)).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/config-bundle");

    await waitForText(screen.lastFrame, "what should this configuration bundle be called?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add
// config-bundle` has to reach the wizard, and everything else has to stay
// headless with the flag path's own errors.
describe("project add config-bundle dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "config-bundle", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add config-bundle in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "config-bundle"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    // The wizard never finishes on its own; Ctrl+C (re-sent until the app
    // reacts, slowly enough that repeats cannot coalesce into one chunk) closes
    // it and resolves the route cleanly. The headless branch would instead
    // reject with the missing --name usage error.
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

  test("bare add config-bundle without a TTY stays headless and reports the missing --name", async () => {
    await inProject();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name' not specified");
  });

  // --name alone is not a bare command, so it must not open the wizard either:
  // the flag path still owns the whole input, and it still requires components.
  test("a name without components stays headless and reports the missing --components", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--name", "runtimeConfig"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--components' not specified");
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option");
  });

  test("flag-driven add config-bundle still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "config-bundle",
      "--name",
      "flagBundle",
      "--components",
      COMPONENTS,
    ]);

    expect((await bundlesOf(projectRoot)).map((bundle: { name: string }) => bundle.name)).toEqual([
      "flagBundle",
    ]);
  }, 10000);
});
