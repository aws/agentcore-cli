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
import { authChoices, splitScopes } from "./screen";

const ENDPOINT = "https://mcp.example.com";
const OAUTH_CREDENTIAL = {
  authorizerType: "OAuthCredentialProvider",
  name: "oauth",
  discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
};
const API_KEY_CREDENTIAL = {
  authorizerType: "ApiKeyCredentialProvider",
  name: "api-key",
};

const { addGateway, cleanup, inProject, projectSpec, run, writeProjectSpec } =
  createGatewayProjectTestHarness("add-gateway-target-wizard");

afterEach(cleanup);
afterEach(cleanupScreens);

async function targetsOf(projectRoot: string, gateway = "tools") {
  const spec = await projectSpec(projectRoot);
  return spec.agentCoreGateways.find((candidate: { name: string }) => candidate.name === gateway)
    .targets;
}

// projectWith seeds the scaffolded project — one Runtime named "agent" — with
// what a test needs before the Gateway is added, so the spec the wizard reads
// already carries it.
async function projectWith(extra: {
  credentials?: unknown[];
  runtimeEndpoints?: Record<string, unknown>;
}): Promise<string> {
  const projectRoot = await inProject();
  const spec = await projectSpec(projectRoot);
  if (extra.credentials) spec.credentials = extra.credentials;
  if (extra.runtimeEndpoints) spec.runtimes[0].endpoints = extra.runtimeEndpoints;
  await writeProjectSpec(projectRoot, spec);
  await addGateway();
  return projectRoot;
}

// reachKindStep confirms the only Gateway, leaving the wizard on the kind step.
async function reachKindStep(screen: RenderScreenResult): Promise<void> {
  await waitForText(screen.lastFrame, "which Gateway should this Target hang off?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what is the Target?");
}

// reachAuthStep answers the endpoint branch through to the auth step.
async function reachAuthStep(screen: RenderScreenResult, name: string): Promise<void> {
  await reachKindStep(screen);
  await screen.press("return");
  await waitForText(screen.lastFrame, "what is the MCP server's HTTPS endpoint?");
  await screen.write(ENDPOINT);
  await screen.press("return");
  await waitForText(screen.lastFrame, "what should this Target be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "how should the Gateway authenticate to it?");
}

describe("gateway-target wizard helpers", () => {
  test("offers only the outbound auth the schema accepts for each shortcut", () => {
    // Neither shortcut type takes API_KEY, and a Runtime is called with the
    // Gateway's role rather than unauthenticated.
    expect(authChoices("endpoint").map((choice) => choice.value)).toEqual(["none", "oauth"]);
    expect(authChoices("runtime").map((choice) => choice.value)).toEqual(["iam", "oauth"]);
  });

  test("splits scopes on spaces and commas", () => {
    expect(splitScopes("read, write  admin")).toEqual(["read", "write", "admin"]);
    expect(splitScopes("  ")).toEqual([]);
  });
});

describe("project add gateway-target wizard", () => {
  test("adds the same MCP server Target as the endpoint flags", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-target");

    await waitForText(screen.lastFrame, "which Gateway should this Target hang off?");
    expect(screen.lastFrame()).toContain("❯ ● tools");
    expect(screen.lastFrame()).toContain("0 Targets · MCP servers and Runtimes");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the Target?");
    expect(screen.lastFrame()).toContain("❯ ● an MCP server I host elsewhere");
    expect(screen.lastFrame()).toContain("○ a Runtime in this project");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the MCP server's HTTPS endpoint?");
    await screen.write(ENDPOINT);
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this Target be called?");
    await screen.write("search");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should the Gateway authenticate to it?");
    expect(screen.lastFrame()).toContain("❯ ● none (default)");
    expect(screen.lastFrame()).toContain("○ OAuth");
    expect(screen.lastFrame()).not.toContain("API key");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Target will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("gateway tools");
    expect(review).toContain("target search");
    expect(review).toContain("kind MCP server");
    expect(review).toContain(`endpoint ${ENDPOINT}`);
    expect(review).toContain("outbound auth none");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added Target 'search' to Gateway 'tools' in 'TestProject'",
    );
    expect(screen.lastFrame()).toContain("[enter] go back");
    expect(await targetsOf(projectRoot)).toEqual([
      {
        name: "search",
        targetType: "mcpServer",
        endpoint: ENDPOINT,
        outboundAuth: { type: "NONE" },
      },
    ]);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("adds a Runtime Target called with the Gateway's own role", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachKindStep(screen);

    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● a Runtime in this project");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which Runtime?");
    expect(screen.lastFrame()).toContain("❯ ● agent");
    await screen.press("return");

    // The scaffolded Runtime declares no named endpoints, so there is nothing
    // to ask: the wizard goes straight to the name.
    await waitForText(screen.lastFrame, "what should this Target be called?");
    expect(screen.lastFrame()).not.toContain("which endpoint on the Runtime?");
    await screen.write("agent_tools");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should the Gateway authenticate to it?");
    expect(screen.lastFrame()).toContain("❯ ● Gateway IAM role (default)");
    expect(screen.lastFrame()).not.toContain("none (default)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Target will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("kind Runtime");
    expect(review).toContain("runtime agent");
    expect(review).toContain("runtime endpoint DEFAULT");
    expect(review).toContain("outbound auth Gateway IAM role");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Target 'agent_tools'");
    // No outboundAuth at all, exactly as `--runtime agent` alone writes it.
    expect(await targetsOf(projectRoot)).toEqual([
      { name: "agent_tools", targetType: "httpRuntime", httpRuntime: { runtime: "agent" } },
    ]);
    screen.unmount();
  }, 15000);

  test("asks which endpoint when the Runtime declares named ones", async () => {
    const projectRoot = await projectWith({
      runtimeEndpoints: { prod: { version: 2, description: "production alias" } },
    });
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachKindStep(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which Runtime?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which endpoint on the Runtime?");
    expect(screen.lastFrame()).toContain("❯ ● DEFAULT (default)");
    expect(screen.lastFrame()).toContain("○ prod");
    expect(screen.lastFrame()).toContain("version 2 · production alias");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this Target be called?");
    await screen.write("prod_tools");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should the Gateway authenticate to it?");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "runtime endpoint prod");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Target 'prod_tools'");
    expect((await targetsOf(projectRoot))[0].httpRuntime).toEqual({
      runtime: "agent",
      runtimeEndpoint: "prod",
    });
    screen.unmount();
  }, 15000);

  test("picks an OAuth credential from the project and collects its scopes", async () => {
    const projectRoot = await projectWith({
      credentials: [OAUTH_CREDENTIAL, API_KEY_CREDENTIAL],
    });
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachAuthStep(screen, "secure");

    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● OAuth");
    await screen.press("return");

    // Only OAuth credentials are listed; the API-key one cannot be picked.
    await waitForText(screen.lastFrame, "which OAuth credential should it use?");
    expect(screen.lastFrame()).toContain("❯ ● oauth");
    expect(screen.lastFrame()).not.toContain("api-key");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which scopes should the token request?");
    await screen.write("read, write");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this Target will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("outbound auth OAuth · oauth");
    expect(review).toContain("scopes read, write");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added Target 'secure'");
    expect((await targetsOf(projectRoot))[0].outboundAuth).toEqual({
      type: "OAUTH",
      credentialName: "oauth",
      scopes: ["read", "write"],
    });
    screen.unmount();
  }, 15000);

  test("without an OAuth credential the credential step says what to add", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachAuthStep(screen, "secure");

    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "no OAuth credentials in this project");
    expect(screen.lastFrame()).toContain("agentcore add credentials oauth");
    await waitFor(() => !(screen.lastFrame() ?? "").includes("[enter]"));
    expect(screen.lastFrame()).toContain("[esc] back");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "how should the Gateway authenticate to it?");
    screen.unmount();
  });

  test("without a Gateway the first step says what to add and esc returns to the menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/gateway-target");

    await waitForText(screen.lastFrame, "no Gateways in this project");
    expect(screen.lastFrame()).toContain("agentcore add gateway");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });

  test("an MCP-only Gateway offers MCP server Targets alone", async () => {
    await inProject();
    await run(["add", "gateway", "--name", "mcp", "--protocol-type", "MCP"]);
    const screen = renderScreen("/agentcore/add/gateway-target");

    await waitForText(screen.lastFrame, "which Gateway should this Target hang off?");
    expect(screen.lastFrame()).toContain("MCP servers only");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the Target?");
    expect(screen.lastFrame()).toContain("❯ ● an MCP server I host elsewhere");
    expect(screen.lastFrame()).not.toContain("a Runtime in this project");
    expect(flatFrame(screen.lastFrame)).toContain("Gateway 'mcp' has protocolType MCP");
    screen.unmount();
  });

  test("a non-HTTPS endpoint keeps the step", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachKindStep(screen);
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the MCP server's HTTPS endpoint?");
    await screen.write("http://mcp.example.com");
    await screen.press("return");

    await waitForText(screen.lastFrame, "must use HTTPS");
    expect(screen.lastFrame()).toContain("what is the MCP server's HTTPS endpoint?");
    screen.unmount();
  });

  test("an endpoint that is not a URL keeps the step", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachKindStep(screen);
    await screen.press("return");

    await waitForText(screen.lastFrame, "what is the MCP server's HTTPS endpoint?");
    await screen.write("not-a-url");
    await screen.press("return");

    await waitForText(screen.lastFrame, "must be a valid HTTPS URL");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await addGateway();
    // The name is taken, so addResource refuses it.
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "search",
      "--endpoint",
      ENDPOINT,
    ]);
    const screen = renderScreen("/agentcore/add/gateway-target");
    await reachAuthStep(screen, "search");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this Target will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(screen.lastFrame, "already exists in gateway 'tools'");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this Target will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("target search");

    expect(await targetsOf(projectRoot)).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    await addGateway();
    const screen = renderScreen("/agentcore/add/gateway-target");

    await waitForText(screen.lastFrame, "which Gateway should this Target hang off?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

// These drive the real CLI entrypoint rather than mounting the screen, because
// what they cover is the routing in front of it: a bare `agentcore add
// gateway-target` has to reach the wizard, and everything else has to stay
// headless.
describe("project add gateway-target dispatch", () => {
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
      .route(["node", "agentcore", "add", "gateway-target", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  test("bare add gateway-target in a TTY session opens the wizard", async () => {
    await inProject();
    await addGateway();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "gateway-target"])
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

  test("bare add gateway-target without a TTY stays headless and reports the missing --gateway", async () => {
    await inProject();

    const error = await routeError(testIO().io, []);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_GATEWAY);
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--name", "search"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_GATEWAY);
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    const error = await routeError(ttyTestIO().streams.io, ["--json"]);

    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain(MISSING_GATEWAY);
  });

  test("flag-driven add gateway-target still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "flagged",
      "--endpoint",
      ENDPOINT,
    ]);

    expect((await targetsOf(projectRoot)).map((target: { name: string }) => target.name)).toEqual([
      "flagged",
    ]);
  }, 10000);
});
