import { afterEach, describe, expect, test } from "bun:test";
import { createPaymentProjectTestHarness } from "../payment-test-support";

const { cleanup, inProject, projectSpec, run, writeProjectSpec } =
  createPaymentProjectTestHarness("payment-connector");

afterEach(cleanup);

async function addManager() {
  await run(["add", "payment-manager", "--name", "payments"]);
}

async function addCredential(name: string, provider: "CoinbaseCDP" | "StripePrivy") {
  await run(["add", "credentials", "payment", "--name", name, "--provider", provider]);
}

describe("project add payment-connector", () => {
  test.each([
    ["CoinbaseCDP", "coinbase"],
    ["StripePrivy", "stripe"],
  ] as const)("reuses an existing %s credential", async (provider, name) => {
    const projectRoot = await inProject();
    await addManager();
    await addCredential(`${name}-credential`, provider);

    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      name,
      "--credential",
      `${name}-credential`,
    ]);

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([
      {
        name,
        provider,
        credentialName: `${name}-credential`,
      },
    ]);
  });

  test("adds Quick Create without a payment credential", async () => {
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

    const spec = await projectSpec(projectRoot);
    expect(spec.credentials).toEqual([]);
    expect(spec.payments[0].connectors).toEqual([
      {
        name: "coinbase",
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
      },
    ]);
  });

  test.each([
    ["missing manager", ["--name", "connector", "--quick-create"], "required option '--manager"],
    ["missing name", ["--manager", "payments", "--quick-create"], "required option '--name"],
    ["no mode", ["--manager", "payments", "--name", "connector"], "specify exactly one"],
    [
      "multiple modes",
      [
        "--manager",
        "payments",
        "--name",
        "connector",
        "--credential",
        "existing",
        "--quick-create",
      ],
      "specify exactly one",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    const projectRoot = await inProject();
    await addManager();

    await expect(run(["add", "payment-connector", ...flags])).rejects.toThrow(message);
    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test("rejects unknown managers and credentials", async () => {
    const projectRoot = await inProject();
    await addManager();

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "missing",
        "--name",
        "connector",
        "--quick-create",
      ]),
    ).rejects.toThrow("does not exist");
    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--credential",
        "missing",
      ]),
    ).rejects.toThrow("does not exist in credentials[]");

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test("rejects non-payment credentials", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run(["add", "credentials", "api-key", "--name", "api-key"]);

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--credential",
        "api-key",
      ]),
    ).rejects.toThrow("not a PaymentCredentialProvider");

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test("rejects duplicate connector names", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "connector",
      "--quick-create",
    ]);

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--quick-create",
      ]),
    ).rejects.toThrow("already exists");

    const spec = await projectSpec(projectRoot);
    expect(spec.credentials).toEqual([]);
    expect(spec.payments[0].connectors).toHaveLength(1);
  });

  test("rejects provider mismatches in complete project data", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [
      {
        authorizerType: "PaymentCredentialProvider",
        name: "coinbase",
        provider: "CoinbaseCDP",
      },
    ];
    spec.payments = [
      {
        name: "payments",
        connectors: [
          {
            name: "stripe",
            provider: "StripePrivy",
            credentialName: "coinbase",
          },
        ],
      },
    ];
    await writeProjectSpec(projectRoot, spec);

    await expect(run(["add", "credentials", "api-key", "--name", "trigger"])).rejects.toThrow(
      "uses provider",
    );
  });
});
