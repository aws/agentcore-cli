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

const { addGateway, cleanup, inProject, projectSpec, run } = createGatewayProjectTestHarness(
  "add-policy-engine-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function nameStep(screen: RenderScreenResult, name: string): Promise<void> {
  await waitForText(screen.lastFrame, "what should this Policy Engine be called?");
  await screen.write(name);
  await screen.press("return");
}

describe("project add policy-engine wizard", () => {
  test("in a project without Gateways it asks only for a name", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/policy-engine");

    await waitForText(screen.lastFrame, "what should this Policy Engine be called?");
    expect(screen.lastFrame()).not.toContain("gateways");
    await screen.write("Guardrails");
    await screen.press("return");

    // No Gateways to attach to, so the attachment step is not offered at all.
    await waitForText(screen.lastFrame, "this Policy Engine will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("policy engine Guardrails");
    expect(review).toContain("gateways (none)");
    expect(review).not.toContain("mode");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Policy Engine 'Guardrails' to 'TestProject'");
    // Bare, so following it opens the policy wizard; --engine would make it headless.
    expect(screen.lastFrame()).toContain("agentcore add policy");
    expect(screen.lastFrame()).not.toContain("--engine");
    expect(screen.lastFrame()).toContain("[enter] go back");
    // The same bare engine `--name Guardrails` writes.
    expect((await projectSpec(projectRoot)).policyEngines).toEqual([
      { name: "Guardrails", policies: [] },
    ]);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("attaches to the Gateways checked, in the mode revealed beneath them", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    await addGateway("search");
    const screen = renderScreen("/agentcore/add/policy-engine");
    await nameStep(screen, "Guardrails");

    await waitForText(screen.lastFrame, "attach it to any Gateways now?");
    expect(screen.lastFrame()).toContain("❯ [ ] tools");
    expect(screen.lastFrame()).toContain("[ ] search");
    // Nothing checked yet, so the mode question is not on screen.
    expect(screen.lastFrame()).not.toContain("Enforcement on those Gateways");

    await screen.write(" ");
    await waitForText(screen.lastFrame, "[✓] tools");
    // Checking a Gateway reveals the mode beneath the list, with enforce
    // preselected; the list keeps the pointer.
    await waitForText(screen.lastFrame, "Enforcement on those Gateways");
    expect(screen.lastFrame()).toContain("● enforce (default)");
    expect(screen.lastFrame()).toContain("❯ [✓] tools");

    await screen.press("down");
    await screen.write(" ");
    await waitForText(screen.lastFrame, "❯ [✓] search");

    // Enter moves focus from the list into the mode rows; down picks log-only.
    await screen.press("return");
    await waitForText(screen.lastFrame, "❯ ● enforce (default)");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● log-only");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Policy Engine will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("gateways tools, search");
    expect(review).toContain("mode log-only");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Policy Engine 'Guardrails'");
    expect(screen.lastFrame()).toContain("attached to 2 Gateways in log-only mode");
    const spec = await projectSpec(projectRoot);
    for (const gateway of spec.agentCoreGateways) {
      expect(gateway.policyEngineConfiguration).toEqual({
        policyEngineName: "Guardrails",
        mode: "LOG_ONLY",
      });
    }
    screen.unmount();
  }, 15000);

  test("enter with nothing checked continues without attaching", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    const screen = renderScreen("/agentcore/add/policy-engine");
    await nameStep(screen, "Guardrails");

    await waitForText(screen.lastFrame, "attach it to any Gateways now?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Policy Engine will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("gateways (none)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Policy Engine 'Guardrails'");
    expect(screen.lastFrame()).not.toContain("attached to");
    const spec = await projectSpec(projectRoot);
    expect(spec.policyEngines).toEqual([{ name: "Guardrails", policies: [] }]);
    expect(spec.agentCoreGateways[0].policyEngineConfiguration).toBeUndefined();
    screen.unmount();
  }, 15000);

  test("up from the first mode row returns to the Gateway list", async () => {
    await inProject();
    await addGateway("tools");
    const screen = renderScreen("/agentcore/add/policy-engine");
    await nameStep(screen, "Guardrails");
    await waitForText(screen.lastFrame, "attach it to any Gateways now?");
    await screen.write(" ");
    await screen.press("return");
    await waitForText(screen.lastFrame, "❯ ● enforce (default)");

    await screen.press("up");

    await waitForText(screen.lastFrame, "❯ [✓] tools");
    expect(screen.lastFrame()).not.toContain("❯ ● enforce (default)");
    screen.unmount();
  });

  test("a name that breaks the schema's pattern is rejected as it is typed", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/policy-engine");

    await waitForText(screen.lastFrame, "what should this Policy Engine be called?");
    await screen.write("9starts");

    await waitForText(screen.lastFrame, "Must begin with a letter");
    screen.unmount();
  });

  test("validates the deployed name against the longest project target", async () => {
    const projectRoot = await inProject();
    await writeFile(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([{ name: "production", account: "111122223333", region: "us-east-1" }]),
    );
    // 26 characters: legal on its own, one over once the project and the target
    // are prefixed.
    const name = `E${"x".repeat(25)}`;
    const screen = renderScreen("/agentcore/add/policy-engine");

    await waitForText(screen.lastFrame, "what should this Policy Engine be called?");
    await screen.write(name);
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "is 49 characters. The maximum is 48.");
    const frame = flatFrame(screen.lastFrame);
    expect(frame).toContain("TestProject_production_");
    expect(frame).toContain("what should this Policy Engine be called?");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await run(["add", "policy-engine", "--name", "Guardrails"]);
    const screen = renderScreen("/agentcore/add/policy-engine");
    await nameStep(screen, "Guardrails");
    await waitForText(screen.lastFrame, "this Policy Engine will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "already exists");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this Policy Engine will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("policy engine Guardrails");

    expect((await projectSpec(projectRoot)).policyEngines).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/policy-engine");

    await waitForText(screen.lastFrame, "what should this Policy Engine be called?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add
// policy-engine` has to reach the wizard, and everything else has to stay
// headless.
describe("project add policy-engine dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  const MISSING_NAME = "required option '--name' not specified";

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "policy-engine", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add policy-engine in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "policy-engine"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

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

  test("bare add policy-engine without a TTY stays headless and reports the missing --name", async () => {
    await inProject();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--description", "guardrails"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_NAME);
  });

  test("flag-driven add policy-engine still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "policy-engine",
      "--name",
      "FlagEngine",
    ]);

    expect((await projectSpec(projectRoot)).policyEngines).toEqual([
      { name: "FlagEngine", policies: [] },
    ]);
  }, 10000);
});
