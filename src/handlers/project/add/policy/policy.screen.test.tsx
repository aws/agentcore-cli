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
import { readableFileSchema } from "./screen";

const FORBID_ALL = "forbid (principal, action, resource);";
const SUPPRESS =
  "suppressOutput (principal, action, resource is AgentCore::Gateway)\n" +
  'when guardrails { BedrockGuardrails::ContentFilter(["HATE"], [context.output.message])' +
  '["HATE"].confidenceScore.greaterThan(decimal("0.2")) };';
const FILE_HELP = "a .cedar file, relative to the current directory or absolute";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("add-policy-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

async function withEngine(): Promise<string> {
  const projectRoot = await inProject();
  await run(["add", "policy-engine", "--name", "Guardrails"]);
  return projectRoot;
}

async function policiesOf(projectRoot: string, engine = "Guardrails") {
  const spec = await projectSpec(projectRoot);
  return spec.policyEngines.find((candidate: { name: string }) => candidate.name === engine)
    .policies;
}

// reachSourceStep confirms the only engine and names the policy, leaving the
// wizard on the statement-source step.
async function reachSourceStep(screen: RenderScreenResult, name: string): Promise<void> {
  await waitForText(screen.lastFrame, "which Policy Engine should this Policy belong to?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what should this Policy be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "where is the Cedar statement?");
}

describe("policy wizard helpers", () => {
  test("readableFileSchema accepts an existing file and refuses anything else", async () => {
    const projectRoot = await inProject();
    const path = join(projectRoot, "deny.cedar");
    await writeFile(path, FORBID_ALL);
    expect(readableFileSchema.safeParse(path).success).toBe(true);
    expect(readableFileSchema.safeParse(join(projectRoot, "missing.cedar")).success).toBe(false);
    // A directory is not a statement.
    expect(readableFileSchema.safeParse(projectRoot).success).toBe(false);
  });
});

describe("project add policy wizard", () => {
  test("adds the same inline policy as the flags, with the inferred phase on review", async () => {
    const projectRoot = await withEngine();
    const screen = renderScreen("/agentcore/add/policy");

    await waitForText(screen.lastFrame, "which Policy Engine should this Policy belong to?");
    expect(screen.lastFrame()).toContain("❯ ● Guardrails");
    expect(screen.lastFrame()).toContain("0 policies");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this Policy be called?");
    await screen.write("DenyAll");
    await screen.press("return");

    await waitForText(screen.lastFrame, "where is the Cedar statement?");
    expect(screen.lastFrame()).toContain("❯ ● type or paste the Cedar statement");
    expect(screen.lastFrame()).toContain("○ load it from a file");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the Cedar statement?");
    expect(screen.lastFrame()).toContain("[ctrl+d] continue");
    await screen.write(FORBID_ALL);
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "should it enforce, or only log?");
    expect(screen.lastFrame()).toContain("❯ ● active (default)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Policy will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("policy engine Guardrails");
    expect(review).toContain("policy DenyAll");
    expect(review).toContain(`statement ${FORBID_ALL}`);
    expect(review).toContain("enforcement active");
    expect(review).toContain("authorization phase INITIATE · inferred from the statement");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added Policy 'DenyAll' to Policy Engine 'Guardrails' in 'TestProject'",
    );
    expect(await policiesOf(projectRoot)).toEqual([
      {
        name: "DenyAll",
        statement: FORBID_ALL,
        validationMode: "FAIL_ON_ANY_FINDINGS",
        enforcementMode: "ACTIVE",
        authorizationPhase: "INITIATE",
      },
    ]);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("loads the statement from a file, recording its path and inferring RETURN_OUTPUT", async () => {
    const projectRoot = await withEngine();
    // Relative to the project, which is the working directory: the path is
    // recorded as typed, the way `--statement file://suppress.cedar` records it.
    const cedarPath = "suppress.cedar";
    await writeFile(join(projectRoot, cedarPath), SUPPRESS);
    const screen = renderScreen("/agentcore/add/policy");
    await reachSourceStep(screen, "Suppress");

    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● load it from a file");
    await screen.press("return");

    // The path input opens under the row.
    await waitForText(screen.lastFrame, FILE_HELP);
    expect(screen.lastFrame()).toContain("where is the Cedar statement?");
    await screen.write(cedarPath);
    await screen.press("return");

    // No editor step for a file; straight on to enforcement.
    await waitForText(screen.lastFrame, "should it enforce, or only log?");
    expect(screen.lastFrame()).not.toContain("what is the Cedar statement?");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● log-only");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Policy will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain(`statement from ${cedarPath}`);
    expect(review).toContain("enforcement log-only");
    expect(review).toContain("authorization phase RETURN_OUTPUT");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Policy 'Suppress'");
    expect((await policiesOf(projectRoot))[0]).toMatchObject({
      statement: SUPPRESS,
      sourceFile: cedarPath,
      enforcementMode: "LOG_ONLY",
      authorizationPhase: "RETURN_OUTPUT",
    });
    screen.unmount();
  }, 15000);

  test("a file that is not there keeps the step", async () => {
    const projectRoot = await withEngine();
    const screen = renderScreen("/agentcore/add/policy");
    await reachSourceStep(screen, "Missing");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, FILE_HELP);

    await screen.press("return");
    await waitForText(screen.lastFrame, "Statement file is required");

    await screen.write(join(projectRoot, "nope.cedar"));
    await screen.press("return");
    await waitForText(screen.lastFrame, "no readable file at");
    expect(screen.lastFrame()).toContain("where is the Cedar statement?");
    screen.unmount();
  });

  test("an empty statement is refused", async () => {
    await withEngine();
    const screen = renderScreen("/agentcore/add/policy");
    await reachSourceStep(screen, "Empty");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what is the Cedar statement?");

    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "Cedar statement is required");
    expect(screen.lastFrame()).not.toContain("should it enforce");
    screen.unmount();
  });

  test("a multi-line statement is kept as typed and previewed on one line", async () => {
    const projectRoot = await withEngine();
    const screen = renderScreen("/agentcore/add/policy");
    await reachSourceStep(screen, "Suppress");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what is the Cedar statement?");

    const [first, second] = SUPPRESS.split("\n");
    await screen.write(first!);
    await screen.press("return");
    await screen.write(second!);
    await screen.press("ctrl+d");
    await waitForText(screen.lastFrame, "should it enforce, or only log?");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "(+1 more line)");
    expect(flatFrame(screen.lastFrame)).toContain("authorization phase RETURN_OUTPUT");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Policy 'Suppress'");
    expect((await policiesOf(projectRoot))[0].statement).toBe(SUPPRESS);
    screen.unmount();
  }, 15000);

  test("without a Policy Engine the first step says what to add and esc returns to the menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/policy");

    await waitForText(screen.lastFrame, "no Policy Engines in this project");
    expect(screen.lastFrame()).toContain("agentcore add policy-engine");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await withEngine();
    await run(["add", "policy-engine", "--name", "Second"]);
    await run([
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "DenyAll",
      "--statement",
      FORBID_ALL,
    ]);
    const screen = renderScreen("/agentcore/add/policy");

    // Pick the second engine; the name is taken by the first, and names are
    // unique across engines, so addResource refuses it.
    await waitForText(screen.lastFrame, "which Policy Engine should this Policy belong to?");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● Second");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what should this Policy be called?");
    await screen.write("DenyAll");
    await screen.press("return");
    await waitForText(screen.lastFrame, "where is the Cedar statement?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what is the Cedar statement?");
    await screen.write(FORBID_ALL);
    await screen.press("ctrl+d");
    await waitForText(screen.lastFrame, "should it enforce, or only log?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this Policy will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "already exists in policy engine 'Guardrails'");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this Policy will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("policy DenyAll");

    expect(await policiesOf(projectRoot, "Second")).toHaveLength(0);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await withEngine();
    const screen = renderScreen("/agentcore/add/policy");

    await waitForText(screen.lastFrame, "which Policy Engine should this Policy belong to?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add policy`
// has to reach the wizard, and everything else has to stay headless.
describe("project add policy dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  const MISSING_ENGINE = "required option '--engine' not specified";

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "policy", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add policy in a TTY session opens the wizard", async () => {
    await withEngine();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "policy"])
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

  test("bare add policy without a TTY stays headless and reports the missing --engine", async () => {
    await withEngine();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_ENGINE);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await withEngine();

    const error = await routeError(ttyTestIO().streams.io, ["--name", "DenyAll"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_ENGINE);
  });

  test("--json stays headless even in a TTY", async () => {
    await withEngine();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_ENGINE);
  });

  test("flag-driven add policy still runs headless in a TTY session", async () => {
    const projectRoot = await withEngine();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "Flagged",
      "--statement",
      FORBID_ALL,
    ]);

    expect((await policiesOf(projectRoot)).map((policy: { name: string }) => policy.name)).toEqual([
      "Flagged",
    ]);
  }, 10000);
});
