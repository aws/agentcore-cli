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

const { cleanup, inProject, projectSpec, run } = createPaymentProjectTestHarness(
  "add-payment-connector-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function addManager(name = "payments") {
  await run(["add", "payment-manager", "--name", name]);
}

async function addPaymentCredential(name: string, provider: "CoinbaseCDP" | "StripePrivy") {
  await run(["add", "credentials", "payment", "--name", name, "--provider", provider]);
}

async function reachName() {
  const screen = renderScreen("/agentcore/add/payment-connector");
  await waitForText(screen.lastFrame, "which payment manager?");
  await screen.press("return");
  await waitForText(screen.lastFrame, "what should this connector be called?");
  return screen;
}

describe("project add payment-connector wizard", () => {
  test("adds the same Quick Create connector as the flags", async () => {
    const projectRoot = await inProject();
    await addManager();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const screen = renderScreen("/agentcore/add/payment-connector", { queryClient });

    await waitForText(screen.lastFrame, "which payment manager?");
    expect(screen.lastFrame()).toContain("❯ ● payments");
    expect(screen.lastFrame()).toContain("0 connectors");
    await screen.press("return");

    await waitForText(screen.lastFrame, "what should this connector be called?");
    await screen.write("coinbase");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how should it be provisioned?");
    expect(screen.lastFrame()).toContain("❯ ● Quick Create a CoinbaseCDP connector");
    expect(screen.lastFrame()).toContain("○ reuse a payment credential");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("payment manager payments");
    expect(review).toContain("connector coinbase");
    expect(review).toContain("provisioning Quick Create");
    expect(review).toContain("provider CoinbaseCDP");
    expect(review).not.toContain("credential");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "added payment connector 'coinbase' to manager 'payments' in 'TestProject'",
    );
    expect(screen.lastFrame()).toContain("agentcore deploy");
    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([
      {
        name: "coinbase",
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
      },
    ]);
    expect(
      queryClient
        .getQueryData<Project>(projectQueryKey())
        ?.spec.payments?.[0]?.connectors.some((connector) => connector.name === "coinbase"),
    ).toBe(true);

    await screen.press("return");
    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  }, 15000);

  test("reuses a payment credential and filters out credentials of other types", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run(["add", "credentials", "api-key", "--name", "api-key"]);
    await addPaymentCredential("coinbase-credential", "CoinbaseCDP");
    await addPaymentCredential("stripe-credential", "StripePrivy");
    const screen = await reachName();

    await screen.write("stripe");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should it be provisioned?");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● reuse a payment credential");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which credential?");
    expect(screen.lastFrame()).toContain("❯ ● coinbase-credential");
    expect(screen.lastFrame()).toContain("○ stripe-credential");
    expect(screen.lastFrame()).not.toContain("api-key");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● stripe-credential");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("provisioning reuse a payment credential");
    expect(review).toContain("provider StripePrivy");
    expect(review).toContain("credential stripe-credential");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added payment connector 'stripe'");
    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([
      {
        name: "stripe",
        provider: "StripePrivy",
        credentialName: "stripe-credential",
      },
    ]);
    screen.unmount();
  }, 15000);

  test("without a payment manager the first step says what to add", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/payment-connector");

    await waitForText(screen.lastFrame, "no payment managers in this project");
    expect(screen.lastFrame()).toContain("agentcore add payment-manager");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "add project resources");
    screen.unmount();
  });

  test("reuse explains how to add a credential when no payment credentials exist", async () => {
    await inProject();
    await addManager();
    await run(["add", "credentials", "api-key", "--name", "api-key"]);
    const screen = await reachName();

    await screen.write("connector");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should it be provisioned?");
    await screen.press("down");
    await screen.press("return");

    await waitForText(screen.lastFrame, "no payment credentials in this project");
    expect(screen.lastFrame()).toContain("agentcore add credentials payment");
    expect(screen.lastFrame()).not.toContain("api-key");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "how should it be provisioned?");
    expect(screen.lastFrame()).toContain("❯ ● reuse a payment credential");
    screen.unmount();
  });

  test("validates the connector name as it is typed", async () => {
    await inProject();
    await addManager();
    const screen = await reachName();

    await screen.write("bad-name");

    await waitForText(screen.lastFrame, "Must begin with a letter");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the form back", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "coinbase",
      "--quick-create",
    ]);
    const screen = await reachName();

    await screen.write("coinbase");
    await screen.press("return");
    await waitForText(screen.lastFrame, "how should it be provisioned?");
    await screen.press("return");
    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    await screen.press("return");

    await waitForFlatText(
      screen.lastFrame,
      "a payment connector with name 'coinbase' already exists in manager 'payments'",
    );
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this connector will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("connector coinbase");
    expect((await projectSpec(projectRoot)).payments[0].connectors).toHaveLength(1);
    screen.unmount();
  }, 15000);
});

describe("project add payment-connector dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "payment-connector", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  function expectMissingManager(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--manager");
  }

  test("bare add payment-connector in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "payment-connector"])
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

  test("bare add payment-connector without a TTY stays headless", async () => {
    await inProject();

    expectMissingManager(await routeError(testIO().io, []));
  });

  test("any user-supplied flag stays headless even in a TTY", async () => {
    await inProject();

    expectMissingManager(await routeError(ttyTestIO().streams.io, ["--quick-create"]));
  });

  test("--json stays headless even in a TTY", async () => {
    await inProject();

    expectMissingManager(await routeError(ttyTestIO().streams.io, ["--json"]));
  });

  test("flag-driven add payment-connector still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    await addManager();
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "coinbase",
      "--quick-create",
    ]);

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([
      {
        name: "coinbase",
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
      },
    ]);
  }, 10000);
});
