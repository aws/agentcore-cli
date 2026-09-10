import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { createECDH, createPrivateKey, createPublicKey } from "node:crypto";
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
import type { Core } from "../../types";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const BASE = ["identity", "payment-credential-provider"];

const FIXTURE_PROVIDER_NAME = "agentcore-cli-payment-fixture";
const FIXTURE_STRIPE_PROVIDER_NAME = "agentcore-cli-payment-fixture-stripe";
const COINBASE_FLAGS = ["--name", "cdp", "--vendor", "CoinbaseCDP", "--api-key-id", "cdp-key-1"];
const STRIPE_FLAGS = [
  "--name",
  "privy",
  "--vendor",
  "StripePrivy",
  "--app-id",
  "privy-app",
  "--authorization-id",
  "privy-auth",
];
const SECRET_REFERENCE = {
  secretId: "arn:aws:secretsmanager:us-west-2:123:secret:payment-fixture",
  jsonKey: "secret",
};
const SECRET_REFERENCE_JSON = JSON.stringify(SECRET_REFERENCE);

// Fixtures are keyed by a hash of the request, so the throwaway secrets must be identical on
// every record and replay. They are derived from fixed bytes rather than committed as key
// material. Coinbase CDP uses a 32-byte Ed25519 seed followed by the 32-byte public key;
// the P-256 wallet keys use SEC1 DER.
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

function p256PrivateKey(fill: number): string {
  const scalar = Buffer.alloc(32, fill);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey();
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: scalar.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
  })
    .export({ format: "der", type: "sec1" })
    .toString("base64");
}

const API_KEY_SECRET = ed25519PrivateKey(0x11);
const WALLET_SECRET = p256PrivateKey(0x22);
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

async function run(
  args: string[],
  stdin?: string,
  core: Core = createFixtureCore(),
): Promise<string> {
  const io = testIO({ stdin });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...BASE, ...args, "--region", REGION]);
  return io.stdout();
}

describe("payment-credential-provider flag validation", () => {
  test.each([
    ["create", "CoinbaseCDP", COINBASE_FLAGS, ["api-key-secret", "wallet-secret"]],
    ["update", "CoinbaseCDP", COINBASE_FLAGS, ["api-key-secret", "wallet-secret"]],
    ["create", "StripePrivy", STRIPE_FLAGS, ["app-secret", "authorization-private-key"]],
    ["update", "StripePrivy", STRIPE_FLAGS, ["app-secret", "authorization-private-key"]],
  ] as const)(
    "`%s` rejects competing %s stdin secrets before Core or IO",
    async (command, _vendor, flags, secretFlags) => {
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
            ...flags,
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

  test.each(["create", "update", "delete"])("requires a name for %s", async (command) => {
    await expect(run([command])).rejects.toThrow("required option '--name <name>' not specified");
  });

  test.each([
    ["create without a vendor", ["create", "--name", "x"], /--vendor <vendor>/],
    ["update without a vendor", ["update", "--name", "x"], /--vendor <vendor>/],
    [
      "create with an unknown vendor",
      ["create", "--name", "x", "--vendor", "Square"],
      "--vendor must be one of CoinbaseCDP, StripePrivy",
    ],
    ["update with tags", ["update", ...COINBASE_FLAGS, "--tags", "a=b"], /--tags/],
    [
      "CoinbaseCDP without --api-key-id",
      ["create", "--name", "x", "--vendor", "CoinbaseCDP"],
      "required option '--api-key-id <api-key-id>' not specified",
    ],
    [
      "StripePrivy without --app-id",
      ["create", "--name", "x", "--vendor", "StripePrivy", "--authorization-id", "a"],
      "required option '--app-id <app-id>' not specified",
    ],
    [
      "StripePrivy without --authorization-id",
      ["create", "--name", "x", "--vendor", "StripePrivy", "--app-id", "a"],
      "required option '--authorization-id <authorization-id>' not specified",
    ],
    [
      "--app-id with CoinbaseCDP",
      ["create", ...COINBASE_FLAGS, "--app-id", "a"],
      "--app-id is not valid with --vendor CoinbaseCDP",
    ],
    [
      "Coinbase flags with StripePrivy",
      [
        "update",
        ...STRIPE_FLAGS,
        "--api-key-id",
        "k",
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      "--api-key-id, --wallet-secret-reference are not valid with --vendor StripePrivy",
    ],
    [
      "CoinbaseCDP without an api key secret",
      ["create", ...COINBASE_FLAGS],
      "either --api-key-secret or --api-key-secret-reference is required",
    ],
    [
      "CoinbaseCDP without a wallet secret",
      ["create", ...COINBASE_FLAGS, "--api-key-secret", "-"],
      "either --wallet-secret or --wallet-secret-reference is required",
    ],
    [
      "CoinbaseCDP with both api key secret forms",
      [
        "create",
        ...COINBASE_FLAGS,
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
      ["create", ...STRIPE_FLAGS, "--authorization-private-key-reference", SECRET_REFERENCE_JSON],
      "either --app-secret or --app-secret-reference is required",
    ],
    [
      "StripePrivy with both authorization private key forms",
      [
        "update",
        ...STRIPE_FLAGS,
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
        "create",
        ...COINBASE_FLAGS,
        "--api-key-secret",
        API_KEY_SECRET,
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      /--api-key-secret must come from stdin \('-'\) or a file \('file:\/\/<path>'\)/,
    ],
  ] as const)("rejects %s before Core", async (_label, args, message) => {
    const core = createFixtureCore();
    const create = spyOn(core.identity, "createPaymentCredentialProvider");
    const update = spyOn(core.identity, "updatePaymentCredentialProvider");

    try {
      await expect(run([...args], undefined, core)).rejects.toThrow(message);
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      update.mockRestore();
    }
  });

  test.each([
    [
      "api key secret that is not an Ed25519 key",
      [
        "create",
        ...COINBASE_FLAGS,
        "--api-key-secret",
        "-",
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      "not-base64!",
      /Ed25519/,
    ],
    [
      "empty app secret",
      [
        "create",
        ...STRIPE_FLAGS,
        "--app-secret",
        "-",
        "--authorization-private-key-reference",
        SECRET_REFERENCE_JSON,
      ],
      "",
      "--app-secret must not be empty",
    ],
  ] as const)("rejects a malformed %s", async (_label, args, stdin, message) => {
    const core = createFixtureCore();
    const create = spyOn(core.identity, "createPaymentCredentialProvider");

    try {
      await expect(run([...args], stdin, core)).rejects.toThrow(message);
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
    }
  });
});

// External-reference fixtures are unavailable; verify the consumer-owned Core contract here.
describe("payment-credential-provider request mapping", () => {
  test("creates a CoinbaseCDP provider with external secret references", async () => {
    const core = new TestCoreClient();
    await run(
      [
        "create",
        ...COINBASE_FLAGS,
        "--api-key-secret-reference",
        SECRET_REFERENCE_JSON,
        "--wallet-secret-reference",
        JSON.stringify({ ...SECRET_REFERENCE, jsonKey: "wallet" }),
      ],
      undefined,
      core,
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
    const core = new TestCoreClient();
    await run(
      [
        "create",
        ...COINBASE_FLAGS,
        "--api-key-secret",
        "-",
        "--wallet-secret-reference",
        SECRET_REFERENCE_JSON,
      ],
      API_KEY_SECRET,
      core,
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
                walletSecretSource: "EXTERNAL",
                walletSecretConfig: SECRET_REFERENCE,
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test.each([
    ["create", "createPaymentCredentialProvider"],
    ["update", "updatePaymentCredentialProvider"],
  ] as const)("%s uses StripePrivy external references", async (command, method) => {
    const core = new TestCoreClient();
    await run(
      [
        command,
        ...STRIPE_FLAGS,
        "--app-secret-reference",
        SECRET_REFERENCE_JSON,
        "--authorization-private-key-reference",
        JSON.stringify({ ...SECRET_REFERENCE, jsonKey: "authorization" }),
      ],
      undefined,
      core,
    );

    expect(core.identity.calls).toEqual([
      {
        method,
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
                authorizationPrivateKeyConfig: { ...SECRET_REFERENCE, jsonKey: "authorization" },
                authorizationId: "privy-auth",
              },
            },
          },
          { region: REGION },
        ],
      },
    ]);
  });
});

// Each command uses the real root and Core; fixture hashes verify the full SDK request,
// including resolved managed secrets. Providers must not exist before a fresh recording.
describe("payment-credential-provider write flow", () => {
  test("creates a CoinbaseCDP provider with managed stdin/file secrets and tags", async () => {
    const stdout = await run(
      [
        "create",
        "--name",
        FIXTURE_PROVIDER_NAME,
        "--vendor",
        "CoinbaseCDP",
        "--api-key-id",
        " agentcore-cli-fixture-key ",
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

  test("updates a payment credential provider with fresh keys", async () => {
    const stdout = await run(
      [
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

  test("creates a StripePrivy provider with managed secrets and strips wallet-auth", async () => {
    const stdout = await run(
      [
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

  test.each([
    [FIXTURE_STRIPE_PROVIDER_NAME, "delete-stripe.golden.json"],
    [FIXTURE_PROVIDER_NAME, "delete.golden.json"],
  ])("deletes %s", async (name, golden) => {
    const core = createFixtureCore();
    const call = spyOn(core.identity, "deletePaymentCredentialProvider");

    try {
      matchGolden(FIXTURES, golden, await run(["delete", "--name", name], undefined, core));
      expect(call.mock.calls).toEqual([[name, { region: REGION }]]);
    } finally {
      call.mockRestore();
    }
  });
});
