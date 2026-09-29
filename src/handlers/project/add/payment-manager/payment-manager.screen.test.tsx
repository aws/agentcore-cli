import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
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
} from "../../../../testing";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createRootHandler } from "../../../index";
import { projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";
import { createPaymentProjectTestHarness } from "../payment-test-support";

const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";
const { cleanup, inProject, projectSpec, run } = createPaymentProjectTestHarness(
  "add-payment-manager-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function reachSpendLimit(name = "payments") {
  const screen = renderScreen("/agentcore/add/payment-manager");
  await waitForText(screen.lastFrame, "what should this payment manager be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "how should payment callers authenticate?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "settle payment requests automatically?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what per-session spend limit?");
  return screen;
}

describe("project add payment-manager wizard", () => {
  test("adds the same default payment manager as the flags", async () => {
    const projectRoot = await inProject();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const screen = renderScreen("/agentcore/add/payment-manager", { queryClient });

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    expect(screen.lastFrame()).toContain("letters and digits");
    await screen.write("payments");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    expect(screen.lastFrame()).toContain("❯ ● AWS_IAM (default)");
    expect(screen.lastFrame()).not.toContain("discovery URL");
    await screen.press("return");

    await waitForText(screen.lastFrame, "settle payment requests automatically?");
    expect(screen.lastFrame()).toContain("❯ ● yes (default)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what per-session spend limit?");
    expect(screen.lastFrame()).toContain("10.00");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("payment manager payments");
    expect(review).toContain("authorizer AWS_IAM");
    expect(review).toContain("auto payment yes");
    expect(review).toContain("spend limit 10.00");
    expect(review).not.toContain("allowed clients");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added payment manager 'payments' to 'TestProject'");
    await screen.resize(80, 24);
    const success = flatFrame(screen.lastFrame);
    expect(success).toContain("auto-payment is ENABLED");
    expect(success).toContain("settle 402 responses without human approval");
    expect(success).toContain("does not modify runtime source code");
    expect(success).toContain("Configure the Payments SDK or plugin");
    expect(screen.lastFrame()).toContain("agentcore deploy");
    expect((await projectSpec(projectRoot)).payments).toEqual([
      {
        name: "payments",
        authorizerType: "AWS_IAM",
        connectors: [],
        autoPayment: true,
        defaultSpendLimit: "10.00",
      },
    ]);
    expect(
      queryClient
        .getQueryData<Project>(projectQueryKey())
        ?.spec.payments?.some((manager) => manager.name === "payments"),
    ).toBe(true);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("collects CUSTOM_JWT fields and disables automatic payment", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("securePayments");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● CUSTOM_JWT");
    await screen.press("return");

    await waitForText(screen.lastFrame, "discovery URL");
    expect(screen.lastFrame()).toContain("how should payment callers authenticate?");
    expect(screen.lastFrame()).toContain("● CUSTOM_JWT");
    expect(screen.lastFrame()).not.toContain("❯ ● CUSTOM_JWT");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");

    await waitForText(screen.lastFrame, "restrict accepted JWTs?");
    expect(screen.lastFrame()).toContain("allowed clients");
    expect(screen.lastFrame()).toContain("allowed audiences");
    expect(screen.lastFrame()).toContain("allowed scopes");
    await screen.write("client-a, client-b");
    await screen.press("return");
    await screen.write("payments, checkout");
    await screen.press("return");
    await screen.write("pay, refund");
    await screen.press("return");

    await waitForText(screen.lastFrame, "settle payment requests automatically?");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● no");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what per-session spend limit?");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("authorizer CUSTOM_JWT");
    expect(review).toContain(`discovery URL ${DISCOVERY_URL}`);
    expect(review).toContain("allowed clients client-a, client-b");
    expect(review).toContain("allowed audiences payments, checkout");
    expect(review).toContain("allowed scopes pay, refund");
    expect(review).toContain("auto payment no");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added payment manager 'securePayments'");
    expect(screen.lastFrame()).not.toContain("auto-payment is ENABLED");
    expect(screen.lastFrame()).toContain("does not modify runtime source code");
    expect((await projectSpec(projectRoot)).payments[0]).toEqual({
      name: "securePayments",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: DISCOVERY_URL,
          allowedClients: ["client-a", "client-b"],
          allowedAudience: ["payments", "checkout"],
          allowedScopes: ["pay", "refund"],
        },
      },
      connectors: [],
      autoPayment: false,
      defaultSpendLimit: "10.00",
    });
    screen.unmount();
  }, 15000);

  test("CUSTOM_JWT allowlists are optional", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("securePayments");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");
    await waitForText(screen.lastFrame, "restrict accepted JWTs?");
    await screen.press("return");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "settle payment requests automatically?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "what per-session spend limit?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");

    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("allowed clients (any)");
    expect(review).toContain("allowed audiences (any)");
    expect(review).toContain("allowed scopes (any)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added payment manager 'securePayments'");
    expect(
      (await projectSpec(projectRoot)).payments[0].authorizerConfiguration.customJWTAuthorizer,
    ).toEqual({ discoveryUrl: DISCOVERY_URL });
    screen.unmount();
  }, 15000);

  test("validates the payment manager name as it is typed", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("bad-name");

    await waitForText(screen.lastFrame, "Must begin with a letter");
    screen.unmount();
  });

  test("validates the CUSTOM_JWT discovery URL before advancing", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("securePayments");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");
    await screen.write("http://idp.example.com");
    await screen.press("return");

    await waitForText(screen.lastFrame, "OIDC discovery URL must use HTTPS");
    expect(screen.lastFrame()).toContain("how should payment callers authenticate?");
    expect(screen.lastFrame()).not.toContain("restrict accepted JWTs?");
    screen.unmount();
  });

  test("validates allowed scopes before advancing", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("securePayments");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");
    await waitForText(screen.lastFrame, "restrict accepted JWTs?");
    await screen.press("return");
    await screen.press("return");
    await screen.write("scope with spaces");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Scope must be printable ASCII with no spaces or quotes");
    expect(screen.lastFrame()).not.toContain("settle payment requests automatically?");
    screen.unmount();
  });

  test("the JWT options page fits an 80x24 terminal", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("securePayments");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");
    await waitForText(screen.lastFrame, "restrict accepted JWTs?");
    await screen.resize(80, 24);

    const frame = screen.lastFrame()!;
    expect(frame).toContain("allowed clients");
    expect(frame).toContain("allowed audiences");
    expect(frame).toContain("allowed scopes");
    expect(frame).toContain("[enter] continue");
    expect(frame).toContain("[esc] back");
    screen.unmount();
  });

  test("esc collapses the discovery URL back into the authorizer choice", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.write("securePayments");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should payment callers authenticate?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "discovery URL");

    await screen.press("escape");

    await waitForText(screen.lastFrame, "❯ ● CUSTOM_JWT");
    expect(screen.lastFrame()).not.toContain("discovery URL");
    screen.unmount();
  });

  test("uses the spend-limit string schema without coercing the value", async () => {
    await inProject();
    const screen = await reachSpendLimit();

    await screen.write("x");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Default spend limit must be a non-negative number");
    expect(screen.lastFrame()).toContain("10.00x");
    expect(screen.lastFrame()).not.toContain("this payment manager will be added");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await run(["add", "payment-manager", "--name", "payments"]);
    const screen = await reachSpendLimit();
    await screen.press("return");
    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(
      screen.lastFrame,
      "a payment-manager with name 'payments' already exists",
    );
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this payment manager will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("payment manager payments");
    expect((await projectSpec(projectRoot)).payments).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the add menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-manager");

    await waitForText(screen.lastFrame, "what should this payment manager be called?");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });
});

describe("project add payment-manager dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "payment-manager", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  function expectMissingName(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name");
  }

  test("bare add payment-manager in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "payment-manager"])
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

  test("bare add payment-manager without a TTY stays headless", async () => {
    await inProject();

    expectMissingName(await routeError(testIO().io, []));
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    expectMissingName(await routeError(ttyTestIO().streams.io, ["--no-auto-payment"]));
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    expectMissingName(await routeError(ttyTestIO().streams.io, ["--json"]));
  });

  test("flag-driven add payment-manager still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "payment-manager",
      "--name",
      "flagPayments",
    ]);

    expect((await projectSpec(projectRoot)).payments).toContainEqual({
      name: "flagPayments",
      authorizerType: "AWS_IAM",
      connectors: [],
      autoPayment: true,
      defaultSpendLimit: "10.00",
    });
  }, 10000);
});
