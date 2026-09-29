import { afterEach, describe, expect, test } from "bun:test";
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
import { knowledgeBaseSchema } from "./screen";

const KB_HELP =
  "a ten-character Knowledge Base ID, or the name of a Knowledge Base in this project";

const { addGateway, cleanup, inProject, projectSpec, run } = createGatewayProjectTestHarness(
  "add-gateway-connector-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function targetsOf(projectRoot: string, gateway = "tools") {
  const spec = await projectSpec(projectRoot);
  return spec.agentCoreGateways.find((candidate: { name: string }) => candidate.name === gateway)
    .targets;
}

// reachConnectorStep confirms the only Gateway, leaving the wizard on the
// connector step.
async function reachConnectorStep(screen: RenderScreenResult): Promise<void> {
  await waitForText(screen.lastFrame, "which Gateway should this connector hang off?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "which connector?");
}

describe("gateway-connector wizard helpers", () => {
  test("a Knowledge Base is a ten-character ID or a project Knowledge Base name", () => {
    const external = knowledgeBaseSchema([]);
    expect(external.safeParse("ABCDEFGHIJ").success).toBe(true);
    expect(external.safeParse("abc").success).toBe(false);
    expect(external.safeParse("docs").success).toBe(false);

    const withProjectKb = knowledgeBaseSchema(["docs"]);
    expect(withProjectKb.safeParse("docs").success).toBe(true);
    expect(withProjectKb.safeParse("ABCDEFGHIJ").success).toBe(true);
    expect(withProjectKb.safeParse("other").success).toBe(false);
  });
});

describe("project add gateway-connector wizard", () => {
  test("adds the same Web Search Target as the flags, with the name prefilled", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-connector");

    await waitForText(screen.lastFrame, "which Gateway should this connector hang off?");
    expect(screen.lastFrame()).toContain("❯ ● tools");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which connector?");
    expect(screen.lastFrame()).toContain("❯ ● web-search");
    expect(screen.lastFrame()).toContain("○ bedrock-knowledge-bases");
    expect(screen.lastFrame()).not.toContain(KB_HELP);
    await screen.press("return");

    // The name defaults to the connector, so enter is enough.
    await waitForText(screen.lastFrame, "what should this Target be called?");
    expect(screen.lastFrame()).toContain("❯ web-search");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("gateway tools");
    expect(review).toContain("target web-search");
    expect(review).toContain("connector web-search");
    expect(review).toContain("tool WebSearch · maxResults 10");
    expect(review).not.toContain("knowledge base");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added Connector Target 'web-search' to Gateway 'tools' in 'TestProject'",
    );
    expect(screen.lastFrame()).toContain("[enter] go back");
    expect(await targetsOf(projectRoot)).toEqual([
      {
        name: "web-search",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      },
    ]);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("takes the Knowledge Base ID in place under its connector", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-connector");
    await reachConnectorStep(screen);

    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● bedrock-knowledge-bases");
    await screen.press("return");

    // The input opens under the rows; the pointer follows focus into it while
    // the radio marker keeps the chosen connector.
    await waitForText(screen.lastFrame, KB_HELP);
    expect(screen.lastFrame()).toContain("which connector?");
    expect(screen.lastFrame()).toContain("● bedrock-knowledge-bases");
    expect(screen.lastFrame()).not.toContain("❯ ● bedrock-knowledge-bases");
    await screen.write("ABCDEFGHIJ");
    await screen.press("return");

    // The prefilled name followed the connector.
    await waitForText(screen.lastFrame, "what should this Target be called?");
    expect(screen.lastFrame()).toContain("❯ bedrock-knowledge-bases");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("connector bedrock-knowledge-bases");
    expect(review).toContain("knowledge base ABCDEFGHIJ");
    expect(review).toContain("tool Retrieve");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Connector Target 'bedrock-knowledge-bases'");
    expect(await targetsOf(projectRoot)).toEqual([
      {
        name: "bedrock-knowledge-bases",
        targetType: "connector",
        connectorId: "bedrock-knowledge-bases",
        configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: "ABCDEFGHIJ" } }],
      },
    ]);
    screen.unmount();
  }, 15000);

  test("a Knowledge Base that is neither an ID nor a project name keeps the step", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-connector");
    await reachConnectorStep(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, KB_HELP);

    await screen.press("return");
    await waitForText(screen.lastFrame, "Knowledge Base is required");

    await screen.write("abc");
    await screen.press("return");
    await waitForText(screen.lastFrame, "must be a ten-character Knowledge Base ID");
    expect(screen.lastFrame()).toContain("which connector?");
    screen.unmount();
  });

  test("esc collapses the Knowledge Base input back into the connector rows", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-connector");
    await reachConnectorStep(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, KB_HELP);

    await screen.press("escape");

    await waitForText(screen.lastFrame, "❯ ● bedrock-knowledge-bases");
    expect(screen.lastFrame()).not.toContain(KB_HELP);
    expect(screen.lastFrame()).toContain("which connector?");
    screen.unmount();
  });

  test("an edited name survives switching connector", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-connector");
    await reachConnectorStep(screen);
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this Target be called?");
    await screen.write("_tools");
    await waitForText(screen.lastFrame, "❯ web-search_tools");

    // Back to the connector step and over to Knowledge Bases: the name is the
    // user's now, so it does not follow the connector.
    await screen.press("escape");
    await waitForText(screen.lastFrame, "which connector?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, KB_HELP);
    await screen.write("ABCDEFGHIJ");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this Target be called?");
    expect(screen.lastFrame()).toContain("❯ web-search_tools");
    screen.unmount();
  });

  test("without a Gateway the first step says what to add and esc returns to the menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/gateway-connector");

    await waitForText(screen.lastFrame, "no Gateways in this project");
    expect(screen.lastFrame()).toContain("agentcore add gateway");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await addGateway();
    // The default name is taken, so addResource refuses it.
    await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "web-search",
      "--connector",
      "web-search",
    ]);
    const screen = renderScreen("/agentcore/add/gateway-connector");
    await reachConnectorStep(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "what should this Target be called?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "already exists in gateway 'tools'");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("target web-search");

    expect(await targetsOf(projectRoot)).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-connector");

    await waitForText(screen.lastFrame, "which Gateway should this connector hang off?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add
// gateway-connector` has to reach the wizard, and everything else has to stay
// headless.
describe("project add gateway-connector dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  const MISSING_GATEWAY = "required option '--gateway";

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "gateway-connector", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add gateway-connector in a TTY session opens the wizard", async () => {
    await inProject();
    await addGateway();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "gateway-connector"])
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
    // reject with the missing --gateway usage error.
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

  test("bare add gateway-connector without a TTY stays headless and reports the missing --gateway", async () => {
    await inProject();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_GATEWAY);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--connector", "web-search"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_GATEWAY);
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_GATEWAY);
  });

  test("flag-driven add gateway-connector still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "flagged",
      "--connector",
      "web-search",
    ]);

    expect((await targetsOf(projectRoot)).map((target: { name: string }) => target.name)).toEqual([
      "flagged",
    ]);
  }, 10000);
});
