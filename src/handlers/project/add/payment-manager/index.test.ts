import { afterEach, describe, expect, test } from "bun:test";
import { createPaymentProjectTestHarness } from "../payment-test-support";

const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";
const { cleanup, inProject, projectSpec, run } = createPaymentProjectTestHarness("payment-manager");

afterEach(cleanup);

describe("project add payment-manager", () => {
  test("adds a manager with materialized defaults", async () => {
    const projectRoot = await inProject();

    const io = await run(["add", "payment-manager", "--name", "payments"]);

    expect((await projectSpec(projectRoot)).payments).toEqual([
      {
        name: "payments",
        authorizerType: "AWS_IAM",
        connectors: [],
        autoPayment: true,
        defaultSpendLimit: "10.00",
      },
    ]);
    expect(io.stderr()).toContain("added payment manager 'payments'");
    expect(io.stderr()).toContain("auto-payment is ENABLED");
    expect(io.stderr()).not.toContain("$10.00");
    expect(io.stderr()).not.toContain("spend limit");
    expect(io.stderr()).toContain("does not modify runtime source code");
  });

  test("maps custom JWT and payment behavior flags", async () => {
    const projectRoot = await inProject();

    const io = await run([
      "add",
      "payment-manager",
      "--name",
      "securePayments",
      "--authorizer-type",
      "CUSTOM_JWT",
      "--discovery-url",
      DISCOVERY_URL,
      "--allowed-clients",
      "client-a",
      "client-b",
      "--allowed-audience",
      "payments",
      "--allowed-scopes",
      "pay",
      "refund",
      "--description",
      "Secure payments",
      "--no-auto-payment",
      "--default-spend-limit",
      "25.50",
      "--tool-allowlist",
      "checkout",
      "refund",
      "--network-preferences",
      "eip155:8453",
      "eip155:1",
    ]);

    expect((await projectSpec(projectRoot)).payments[0]).toEqual({
      name: "securePayments",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: DISCOVERY_URL,
          allowedClients: ["client-a", "client-b"],
          allowedAudience: ["payments"],
          allowedScopes: ["pay", "refund"],
        },
      },
      connectors: [],
      description: "Secure payments",
      autoPayment: false,
      defaultSpendLimit: "25.50",
      paymentToolAllowlist: ["checkout", "refund"],
      networkPreferences: ["eip155:8453", "eip155:1"],
    });
    expect(io.stderr()).not.toContain("auto-payment is ENABLED");
    expect(io.stderr()).toContain("does not modify runtime source code");
  });

  test.each([
    ["missing name", [], "required option '--name"],
    [
      "CUSTOM_JWT without discovery URL",
      ["--name", "payments", "--authorizer-type", "CUSTOM_JWT"],
      "requires --discovery-url",
    ],
    [
      "JWT fields with AWS_IAM",
      ["--name", "payments", "--allowed-scopes", "pay"],
      "valid only with CUSTOM_JWT",
    ],
    [
      "negative default spend limit",
      ["--name", "payments", "--default-spend-limit", "-1"],
      "non-negative",
    ],
    [
      "blank default spend limit",
      ["--name", "payments", "--default-spend-limit", ""],
      "non-negative",
    ],
    ["invalid name", ["--name", "bad-name"], "alphanumeric"],
  ])("rejects %s", async (_label, flags, message) => {
    const projectRoot = await inProject();

    await expect(run(["add", "payment-manager", ...flags])).rejects.toThrow(message);
    expect((await projectSpec(projectRoot)).payments ?? []).toEqual([]);
  });

  test("rejects duplicate manager names", async () => {
    const projectRoot = await inProject();
    await run(["add", "payment-manager", "--name", "payments"]);

    await expect(run(["add", "payment-manager", "--name", "payments"])).rejects.toThrow(
      "already exists",
    );
    expect((await projectSpec(projectRoot)).payments).toHaveLength(1);
  });
});
