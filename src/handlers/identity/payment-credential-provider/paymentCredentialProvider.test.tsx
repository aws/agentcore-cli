import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const BASE = ["identity", "payment-credential-provider"];

// Record with RECORD=1 AWS_PROFILE=deploy bun test src/handlers/identity/payment-credential-provider/paymentCredentialProvider.test.tsx
// None of the fixture providers should exist before recording. The RECORD run creates
// two CoinbaseCDP providers, exercises pagination (requires >=2), updates one, attempts
// a StripePrivy provider, then deletes everything it created.
const FIXTURE_PROVIDER_NAME = "agentcore-cli-payment-fixture";
const FIXTURE_PROVIDER_NAME_2 = "agentcore-cli-payment-fixture-2";
const FIXTURE_STRIPE_PROVIDER_NAME = "agentcore-cli-payment-fixture-stripe";
const SECRET_REFERENCE = {
  secretId: "arn:aws:secretsmanager:us-west-2:123:secret:payment-fixture",
  jsonKey: "secret",
};
const SECRET_REFERENCE_JSON = JSON.stringify(SECRET_REFERENCE);

// Fixtures are keyed by a hash of the request, so the throwaway secrets must be identical on
// every record and replay. They are derived from fixed bytes rather than committed as key
// material. The service wants the Coinbase CDP form of an Ed25519 key (32-byte seed followed
// by the 32-byte public key; a bare seed is rejected), and the P-256 key is assembled as SEC1
// DER from a fixed scalar (the same encoding `openssl ecparam -genkey -outform DER` emits).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519PrivateKey(fill: number): string {
  const seed = Buffer.alloc(32, fill);
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.concat([seed, spki.subarray(spki.length - 32)]).toString("base64");
}

const P256_OID = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
const EC_PUBLIC_KEY_OID = Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);

function der(tag: number, body: Buffer): Buffer {
  if (body.length > 127) throw new Error("single-byte DER lengths only");
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
}

function p256PrivateKey(fill: number): string {
  const scalar = Buffer.alloc(32, fill);
  const bareKey = der(0x30, Buffer.concat([der(0x02, Buffer.from([1])), der(0x04, scalar)]));
  const algorithm = der(0x30, Buffer.concat([EC_PUBLIC_KEY_OID, P256_OID]));
  const pkcs8 = der(
    0x30,
    Buffer.concat([der(0x02, Buffer.from([0])), algorithm, der(0x04, bareKey)]),
  );
  const spki = createPublicKey(
    createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" }) as Buffer;
  const point = spki.subarray(spki.length - 65);
  return der(
    0x30,
    Buffer.concat([
      der(0x02, Buffer.from([1])),
      der(0x04, scalar),
      der(0xa0, P256_OID),
      der(0xa1, der(0x03, Buffer.concat([Buffer.from([0]), point]))),
    ]),
  ).toString("base64");
}

const API_KEY_SECRET = ed25519PrivateKey(0x11);
const WALLET_SECRET = p256PrivateKey(0x22);
const API_KEY_SECRET_2 = ed25519PrivateKey(0x33);
const WALLET_SECRET_2 = p256PrivateKey(0x44);
const UPDATED_API_KEY_SECRET = ed25519PrivateKey(0x55);
const UPDATED_WALLET_SECRET = p256PrivateKey(0x66);
const APP_SECRET = p256PrivateKey(0x77);
const AUTHORIZATION_PRIVATE_KEY = p256PrivateKey(0x88);

const SECRETS_DIR = mkdtempSync(join(tmpdir(), "agentcore-payment-fixture-"));
afterAll(() => rmSync(SECRETS_DIR, { recursive: true, force: true }));

function secretFile(name: string, content: string): string {
  const path = join(SECRETS_DIR, name);
  writeFileSync(path, `${content}\n`);
  return `file://${path}`;
}

const WALLET_SECRET_FILE = secretFile("wallet-secret", WALLET_SECRET);
const WALLET_SECRET_FILE_2 = secretFile("wallet-secret-2", WALLET_SECRET_2);
const UPDATED_WALLET_SECRET_FILE = secretFile("wallet-secret-updated", UPDATED_WALLET_SECRET);
const AUTHORIZATION_PRIVATE_KEY_FILE = secretFile(
  "authorization-private-key",
  `wallet-auth:${AUTHORIZATION_PRIVATE_KEY}`,
);

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

async function runRecorded(args: string[], stdin?: string): Promise<string> {
  const io = testIO({ stdin });
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

async function run(
  args: string[],
  stdin?: string,
  core = new TestCoreClient(),
): Promise<{ core: TestCoreClient; stdout: string }> {
  const io = testIO({ stdin });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { core, stdout: io.stdout() };
}

describe("payment-credential-provider command hierarchy", () => {
  test("registers the payment-credential-provider command hierarchy", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const identity = root.children().find((child) => child.name() === "identity");
    const payment = identity
      ?.children()
      .find((child) => child.name() === "payment-credential-provider");

    expect(payment?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "update",
      "delete",
    ]);
  });

  test("prints help for `identity payment-credential-provider --json` without an SDK call", async () => {
    const { core, stdout } = await run([...BASE, "--json"]);

    expect(stdout).toContain("Usage: agentcore identity payment-credential-provider");
    expect(stdout).toContain("Commands:");
    expect(core.identity.calls).toEqual([]);
  });
});

describe("payment-credential-provider TUI dispatch", () => {
  test("opens the TUI for a bare `payment-credential-provider`", async () => {
    await expect(run([...BASE])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
  });

  test.each(["create", "get", "update", "delete"] as const)(
    "runs normal validation for bare CLI-only `%s`",
    async (command) => {
      await expect(run([...BASE, command])).rejects.toThrow(
        "required option '--name <name>' not specified",
      );
    },
  );

  test("runs a bare `list` headlessly", async () => {
    const { core } = await run([...BASE, "list"]);

    expect(core.identity.calls).toEqual([
      {
        method: "listPaymentCredentialProviders",
        args: [undefined, undefined, { region: REGION }],
      },
    ]);
  });
});

describe("payment-credential-provider flag validation", () => {
  test.each([
    ["create", "CoinbaseCDP", ["--api-key-id", "k"], ["api-key-secret", "wallet-secret"]],
    ["update", "CoinbaseCDP", ["--api-key-id", "k"], ["api-key-secret", "wallet-secret"]],
    [
      "create",
      "StripePrivy",
      ["--app-id", "a", "--authorization-id", "b"],
      ["app-secret", "authorization-private-key"],
    ],
    [
      "update",
      "StripePrivy",
      ["--app-id", "a", "--authorization-id", "b"],
      ["app-secret", "authorization-private-key"],
    ],
  ] as const)(
    "`%s` rejects competing %s stdin secrets before Core or IO",
    async (command, vendor, identifiers, secretFlags) => {
      const factories = fixtureFactories(FIXTURES);
      const sdk = mock(() => {
        throw new Error("unexpected SDK client creation");
      });
      for (const name of Object.keys(factories) as (keyof typeof factories)[]) {
        spyOn(factories, name).mockImplementation(sdk);
      }
      const core = new CoreClient({ ...factories, logger: createSilentLogger() });
      const call = spyOn(
        core.identity,
        command === "create"
          ? "createPaymentCredentialProvider"
          : "updatePaymentCredentialProvider",
      );
      const read = mock(() => {
        throw new Error("unexpected stdin read");
      });
      const stdin = new Readable({ read });
      const io = testIO();
      io.io.stdin = stdin as NodeJS.ReadStream;
      const root = createRootHandler(core, {
        io: io.io,
        logger: createSilentLogger(),
        globalConfigAccessor: new TestGlobalConfigAccessor(),
      });

      try {
        await expect(
          root.route([
            "node",
            "agentcore",
            ...BASE,
            command,
            "--name",
            "x",
            "--vendor",
            vendor,
            ...identifiers,
            ...secretFlags.flatMap((flagName) => [`--${flagName}`, "-"]),
            "--region",
            REGION,
          ]),
        ).rejects.toThrow(
          `--${secretFlags[0]} and --${secretFlags[1]} cannot both read from stdin`,
        );
        expect(call).not.toHaveBeenCalled();
        expect(sdk).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(io.stdout()).toBe("");
        expect(io.stderr()).toBe("");
      } finally {
        call.mockRestore();
        stdin.destroy();
      }
    },
  );

  test.each([
    ["create --name only", [...BASE, "create", "--name", "x"], /--vendor <vendor>/],
    [
      "create with an unknown vendor",
      [...BASE, "create", "--name", "x", "--vendor", "Square"],
      "--vendor must be one of CoinbaseCDP, StripePrivy",
    ],
    ["get --json (no name)", [...BASE, "get", "--json"], /--name <name>/],
    ["delete --json (no name)", [...BASE, "delete", "--json"], /--name <name>/],
    ["update --name only", [...BASE, "update", "--name", "x"], /--vendor <vendor>/],
    [
      "update rejects --tags",
      [...BASE, "update", "--name", "x", "--vendor", "CoinbaseCDP", "--tags", "a=b"],
      /--tags/,
    ],
    [
      "CoinbaseCDP without --api-key-id",
      [...BASE, "create", "--name", "x", "--vendor", "CoinbaseCDP", "--api-key-secret", "-"],
      "required option '--api-key-id <api-key-id>' not specified",
    ],
    [
      "StripePrivy without --app-id",
      [...BASE, "create", "--name", "x", "--vendor", "StripePrivy", "--authorization-id", "a"],
      "required option '--app-id <app-id>' not specified",
    ],
    [
      "StripePrivy without --authorization-id",
      [...BASE, "create", "--name", "x", "--vendor", "StripePrivy", "--app-id", "a"],
      "required option '--authorization-id <authorization-id>' not specified",
    ],
  ] as const)("rejects missing required flags for `%s`", async (_label, args, message) => {
    await expect(run([...args])).rejects.toThrow(message);
  });

  test.each([
    [
      "--app-id with CoinbaseCDP",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--app-id",
        "a",
      ],
      "--app-id is not valid with --vendor CoinbaseCDP",
    ],
    [
      "Coinbase flags with StripePrivy",
      [
        ...BASE,
        "update",
        "--name",
        "x",
        "--vendor",
        "StripePrivy",
        "--api-key-id",
        "k",
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      "--api-key-id, --wallet-secret-reference are not valid with --vendor StripePrivy",
    ],
  ] as const)("rejects flags of the other vendor for `%s`", async (_label, args, message) => {
    await expect(run([...args])).rejects.toThrow(message);
  });

  test.each([
    [
      "CoinbaseCDP without an api key secret",
      [...BASE, "create", "--name", "x", "--vendor", "CoinbaseCDP", "--api-key-id", "k"],
      "either --api-key-secret or --api-key-secret-reference is required",
    ],
    [
      "CoinbaseCDP without a wallet secret",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--api-key-secret",
        "-",
      ],
      "either --wallet-secret or --wallet-secret-reference is required",
    ],
    [
      "CoinbaseCDP with both api key secret forms",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--api-key-secret",
        "-",
        "--api-key-secret-reference",
        SECRET_REFERENCE_JSON,
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      "--api-key-secret and --api-key-secret-reference are mutually exclusive",
    ],
    [
      "StripePrivy without an app secret",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "StripePrivy",
        "--app-id",
        "a",
        "--authorization-id",
        "b",
        "--authorization-private-key-reference",
        SECRET_REFERENCE_JSON,
      ],
      "either --app-secret or --app-secret-reference is required",
    ],
    [
      "StripePrivy with both authorization private key forms",
      [
        ...BASE,
        "update",
        "--name",
        "x",
        "--vendor",
        "StripePrivy",
        "--app-id",
        "a",
        "--authorization-id",
        "b",
        "--app-secret-reference",
        SECRET_REFERENCE_JSON,
        "--authorization-private-key",
        "-",
        "--authorization-private-key-reference",
        SECRET_REFERENCE_JSON,
      ],
      "--authorization-private-key and --authorization-private-key-reference are mutually exclusive",
    ],
    [
      "inline api key secret value",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--api-key-secret",
        API_KEY_SECRET,
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      /--api-key-secret must come from stdin \('-'\) or a file \('file:\/\/<path>'\)/,
    ],
    [
      "malformed secret reference",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--api-key-secret-reference",
        '{"jsonKey":"k"}',
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      /--api-key-secret-reference must be a JSON object/,
    ],
    [
      "invalid api key id",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "bad key!",
        "--api-key-secret-reference",
        SECRET_REFERENCE_JSON,
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      "--api-key-id must contain only alphanumeric characters, hyphens, and underscores",
    ],
  ] as const)("rejects invalid secret input for `%s`", async (_label, args, message) => {
    const core = new TestCoreClient();

    await expect(run([...args], undefined, core)).rejects.toThrow(message);
    expect(core.identity.calls).toEqual([]);
  });

  test.each([
    [
      "api key secret that is not an Ed25519 key",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--api-key-secret",
        "-",
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      "not-base64!",
      /Ed25519/,
    ],
    [
      "wallet secret that is not a P-256 key",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "k",
        "--api-key-secret-reference",
        SECRET_REFERENCE_JSON,
        "--wallet-secret",
        "-",
      ],
      API_KEY_SECRET,
      /P-256/,
    ],
    [
      "authorization private key that is not base64",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "StripePrivy",
        "--app-id",
        "a",
        "--authorization-id",
        "b",
        "--app-secret-reference",
        SECRET_REFERENCE_JSON,
        "--authorization-private-key",
        "-",
      ],
      "wallet-auth:not-base64!",
      /authorizationPrivateKey must be base64-encoded/,
    ],
    [
      "empty app secret",
      [
        ...BASE,
        "create",
        "--name",
        "x",
        "--vendor",
        "StripePrivy",
        "--app-id",
        "a",
        "--authorization-id",
        "b",
        "--app-secret",
        "-",
        "--authorization-private-key-reference",
        SECRET_REFERENCE_JSON,
      ],
      "",
      "--app-secret must not be empty",
    ],
  ] as const)("rejects a malformed %s", async (_label, args, stdin, message) => {
    const core = new TestCoreClient();

    await expect(run([...args], stdin, core)).rejects.toThrow(message);
    expect(core.identity.calls).toEqual([]);
  });
});

describe("payment-credential-provider request mapping", () => {
  test("creates a CoinbaseCDP provider with managed secrets and tags", async () => {
    const { core } = await run(
      [
        ...BASE,
        "create",
        "--name",
        "cdp",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        " cdp-key-1 ",
        "--api-key-secret",
        "-",
        "--wallet-secret",
        WALLET_SECRET_FILE,
        "--tags",
        "team=payments",
        "--tags",
        "env=test",
      ],
      API_KEY_SECRET,
    );

    expect(core.identity.calls).toEqual([
      {
        method: "createPaymentCredentialProvider",
        args: [
          {
            name: "cdp",
            credentialProviderVendor: "CoinbaseCDP",
            providerConfigurationInput: {
              coinbaseCdpConfiguration: {
                apiKeyId: "cdp-key-1",
                apiKeySecret: API_KEY_SECRET,
                apiKeySecretSource: "MANAGED",
                walletSecret: WALLET_SECRET,
                walletSecretSource: "MANAGED",
              },
            },
            tags: { team: "payments", env: "test" },
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("creates a CoinbaseCDP provider with external secret references", async () => {
    const { core } = await run([
      ...BASE,
      "create",
      "--name",
      "cdp",
      "--vendor",
      "CoinbaseCDP",
      "--api-key-id",
      "cdp-key-1",
      "--api-key-secret-reference",
      SECRET_REFERENCE_JSON,
      "--wallet-secret-reference",
      JSON.stringify({ ...SECRET_REFERENCE, jsonKey: "wallet" }),
    ]);

    expect(core.identity.calls).toEqual([
      {
        method: "createPaymentCredentialProvider",
        args: [
          {
            name: "cdp",
            credentialProviderVendor: "CoinbaseCDP",
            providerConfigurationInput: {
              coinbaseCdpConfiguration: {
                apiKeyId: "cdp-key-1",
                apiKeySecretSource: "EXTERNAL",
                apiKeySecretConfig: SECRET_REFERENCE,
                walletSecretSource: "EXTERNAL",
                walletSecretConfig: { ...SECRET_REFERENCE, jsonKey: "wallet" },
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("mixes a managed api key secret with an external wallet secret", async () => {
    const { core } = await run(
      [
        ...BASE,
        "create",
        "--name",
        "cdp",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "cdp-key-1",
        "--api-key-secret",
        "-",
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      API_KEY_SECRET,
    );

    expect(core.identity.calls[0]?.args[0]).toMatchObject({
      providerConfigurationInput: {
        coinbaseCdpConfiguration: {
          apiKeySecret: API_KEY_SECRET,
          apiKeySecretSource: "MANAGED",
          walletSecretSource: "EXTERNAL",
          walletSecretConfig: SECRET_REFERENCE,
        },
      },
    });
  });

  test("creates a StripePrivy provider with managed secrets and strips the wallet-auth prefix", async () => {
    const { core } = await run(
      [
        ...BASE,
        "create",
        "--name",
        "privy",
        "--vendor",
        "StripePrivy",
        "--app-id",
        "privy-app",
        "--app-secret",
        "-",
        "--authorization-id",
        "privy-auth",
        "--authorization-private-key",
        AUTHORIZATION_PRIVATE_KEY_FILE,
      ],
      APP_SECRET,
    );

    expect(core.identity.calls).toEqual([
      {
        method: "createPaymentCredentialProvider",
        args: [
          {
            name: "privy",
            credentialProviderVendor: "StripePrivy",
            providerConfigurationInput: {
              stripePrivyConfiguration: {
                appId: "privy-app",
                appSecret: APP_SECRET,
                appSecretSource: "MANAGED",
                authorizationPrivateKey: AUTHORIZATION_PRIVATE_KEY,
                authorizationPrivateKeySource: "MANAGED",
                authorizationId: "privy-auth",
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("creates a StripePrivy provider with external secret references", async () => {
    const { core } = await run([
      ...BASE,
      "create",
      "--name",
      "privy",
      "--vendor",
      "StripePrivy",
      "--app-id",
      "privy-app",
      "--app-secret-reference",
      SECRET_REFERENCE_JSON,
      "--authorization-id",
      "privy-auth",
      "--authorization-private-key-reference",
      JSON.stringify({ ...SECRET_REFERENCE, jsonKey: "authorization" }),
    ]);

    expect(core.identity.calls[0]?.args[0]).toEqual({
      name: "privy",
      credentialProviderVendor: "StripePrivy",
      providerConfigurationInput: {
        stripePrivyConfiguration: {
          appId: "privy-app",
          appSecretSource: "EXTERNAL",
          appSecretConfig: SECRET_REFERENCE,
          authorizationPrivateKeySource: "EXTERNAL",
          authorizationPrivateKeyConfig: { ...SECRET_REFERENCE, jsonKey: "authorization" },
          authorizationId: "privy-auth",
        },
      },
    });
  });

  test("updates a CoinbaseCDP provider with a full replacement configuration", async () => {
    const { core } = await run(
      [
        ...BASE,
        "update",
        "--name",
        "cdp",
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "cdp-key-2",
        "--api-key-secret",
        "-",
        "--wallet-secret",
        UPDATED_WALLET_SECRET_FILE,
      ],
      UPDATED_API_KEY_SECRET,
    );

    expect(core.identity.calls).toEqual([
      {
        method: "updatePaymentCredentialProvider",
        args: [
          {
            name: "cdp",
            credentialProviderVendor: "CoinbaseCDP",
            providerConfigurationInput: {
              coinbaseCdpConfiguration: {
                apiKeyId: "cdp-key-2",
                apiKeySecret: UPDATED_API_KEY_SECRET,
                apiKeySecretSource: "MANAGED",
                walletSecret: UPDATED_WALLET_SECRET,
                walletSecretSource: "MANAGED",
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
    expect(core.identity.calls[0]?.args[0]).not.toHaveProperty("tags");
  });

  test("updates a StripePrivy provider with external secret references", async () => {
    const { core } = await run([
      ...BASE,
      "update",
      "--name",
      "privy",
      "--vendor",
      "StripePrivy",
      "--app-id",
      "privy-app",
      "--app-secret-reference",
      SECRET_REFERENCE_JSON,
      "--authorization-id",
      "privy-auth",
      "--authorization-private-key-reference",
      SECRET_REFERENCE_JSON,
    ]);

    expect(core.identity.calls).toEqual([
      {
        method: "updatePaymentCredentialProvider",
        args: [
          {
            name: "privy",
            credentialProviderVendor: "StripePrivy",
            providerConfigurationInput: {
              stripePrivyConfiguration: {
                appId: "privy-app",
                appSecretSource: "EXTERNAL",
                appSecretConfig: SECRET_REFERENCE,
                authorizationPrivateKeySource: "EXTERNAL",
                authorizationPrivateKeyConfig: SECRET_REFERENCE,
                authorizationId: "privy-auth",
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("passes --name through to get and delete", async () => {
    const get = await run([...BASE, "get", "--name", "cdp"]);
    const del = await run([...BASE, "delete", "--name", "cdp"]);

    expect(get.core.identity.calls).toEqual([
      { method: "getPaymentCredentialProvider", args: ["cdp", { region: REGION }] },
    ]);
    expect(del.core.identity.calls).toEqual([
      { method: "deletePaymentCredentialProvider", args: ["cdp", { region: REGION }] },
    ]);
  });

  test("passes pagination flags through to list", async () => {
    const { core } = await run([...BASE, "list", "--next-token", "token-1", "--max-results", "5"]);

    expect(core.identity.calls).toEqual([
      { method: "listPaymentCredentialProviders", args: ["token-1", 5, { region: REGION }] },
    ]);
  });
});

describe("payment-credential-provider CRUDL", () => {
  test("creates a CoinbaseCDP payment credential provider", async () => {
    const stdout = await runRecorded(
      [
        ...BASE,
        "create",
        "--name",
        FIXTURE_PROVIDER_NAME,
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "agentcore-cli-fixture-key",
        "--api-key-secret",
        "-",
        "--wallet-secret",
        WALLET_SECRET_FILE,
        "--tags",
        "owner=agentcore-cli-tests",
      ],
      API_KEY_SECRET,
    );

    matchGolden(FIXTURES, "create.golden.json", stdout);
    expect(JSON.parse(stdout)).toMatchObject({
      name: FIXTURE_PROVIDER_NAME,
      credentialProviderVendor: "CoinbaseCDP",
    });
  });

  test("creates a second CoinbaseCDP provider for pagination", async () => {
    const stdout = await runRecorded(
      [
        ...BASE,
        "create",
        "--name",
        FIXTURE_PROVIDER_NAME_2,
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "agentcore-cli-fixture-key-2",
        "--api-key-secret",
        "-",
        "--wallet-secret",
        WALLET_SECRET_FILE_2,
      ],
      API_KEY_SECRET_2,
    );

    matchGolden(FIXTURES, "create-2.golden.json", stdout);
    expect(JSON.parse(stdout).name).toBe(FIXTURE_PROVIDER_NAME_2);
  });

  test("gets a payment credential provider", async () => {
    const stdout = await runRecorded([...BASE, "get", "--name", FIXTURE_PROVIDER_NAME]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout)).toMatchObject({
      name: FIXTURE_PROVIDER_NAME,
      credentialProviderVendor: "CoinbaseCDP",
    });
  });

  test("lists payment credential providers", async () => {
    const stdout = await runRecorded([...BASE, "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    const names = JSON.parse(stdout).credentialProviders.map(
      (provider: { name: string }) => provider.name,
    );
    expect(names).toContain(FIXTURE_PROVIDER_NAME);
    expect(names).toContain(FIXTURE_PROVIDER_NAME_2);
  });

  test("paginates the list with --max-results and --next-token", async () => {
    const firstPage = await runRecorded([...BASE, "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.credentialProviders).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await runRecorded([
      ...BASE,
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).credentialProviders).toHaveLength(1);
  });

  test("updates a payment credential provider with fresh keys", async () => {
    const stdout = await runRecorded(
      [
        ...BASE,
        "update",
        "--name",
        FIXTURE_PROVIDER_NAME,
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        "agentcore-cli-fixture-key-rotated",
        "--api-key-secret",
        "-",
        "--wallet-secret",
        UPDATED_WALLET_SECRET_FILE,
      ],
      UPDATED_API_KEY_SECRET,
    );

    matchGolden(FIXTURES, "update.golden.json", stdout);
    expect(JSON.parse(stdout).name).toBe(FIXTURE_PROVIDER_NAME);
  });

  test("creates a StripePrivy payment credential provider", async () => {
    const stdout = await runRecorded(
      [
        ...BASE,
        "create",
        "--name",
        FIXTURE_STRIPE_PROVIDER_NAME,
        "--vendor",
        "StripePrivy",
        "--app-id",
        "agentcore-cli-fixture-app",
        "--app-secret",
        "-",
        "--authorization-id",
        "agentcore-cli-fixture-auth",
        "--authorization-private-key",
        AUTHORIZATION_PRIVATE_KEY_FILE,
      ],
      APP_SECRET,
    );

    matchGolden(FIXTURES, "create-stripe.golden.json", stdout);
    expect(JSON.parse(stdout)).toMatchObject({
      name: FIXTURE_STRIPE_PROVIDER_NAME,
      credentialProviderVendor: "StripePrivy",
    });
  });

  test("deletes the StripePrivy payment credential provider", async () => {
    const stdout = await runRecorded([...BASE, "delete", "--name", FIXTURE_STRIPE_PROVIDER_NAME]);

    matchGolden(FIXTURES, "delete-stripe.golden.json", stdout);
  });

  test("deletes the first payment credential provider", async () => {
    const stdout = await runRecorded([...BASE, "delete", "--name", FIXTURE_PROVIDER_NAME]);

    matchGolden(FIXTURES, "delete.golden.json", stdout);
  });

  test("deletes the second payment credential provider", async () => {
    const stdout = await runRecorded([...BASE, "delete", "--name", FIXTURE_PROVIDER_NAME_2]);

    matchGolden(FIXTURES, "delete-2.golden.json", stdout);
  });

  test("propagates ResourceNotFoundException from get once the provider is deleted", async () => {
    await expect(
      runRecorded([...BASE, "get", "--name", FIXTURE_PROVIDER_NAME_2]),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });

  test("no longer lists the deleted providers", async () => {
    const stdout = await runRecorded([...BASE, "list", "--max-results", "20"]);

    matchGolden(FIXTURES, "list-after-delete.golden.json", stdout);
    const names = JSON.parse(stdout).credentialProviders.map(
      (provider: { name: string }) => provider.name,
    );
    expect(names).not.toContain(FIXTURE_PROVIDER_NAME);
    expect(names).not.toContain(FIXTURE_PROVIDER_NAME_2);
    expect(names).not.toContain(FIXTURE_STRIPE_PROVIDER_NAME);
  });
});
