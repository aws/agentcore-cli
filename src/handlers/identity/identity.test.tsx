import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// Record with RECORD=1 bun test src/handlers/identity/identity.test.tsx
// Neither fixture provider should exist before recording. The RECORD run creates
// both providers, exercises pagination (requires >=2), then deletes them.
const FIXTURE_PROVIDER_NAME = "agentcore-cli-identity-fixture";
const FIXTURE_PROVIDER_NAME_2 = "agentcore-cli-identity-fixture-2";
const MISSING_PROVIDER_NAME = "missing-provider-000";

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

async function run(args: string[], stdin?: string): Promise<string> {
  const io = testIO({ stdin });
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("identity command hierarchy", () => {
  test("registers the identity command hierarchy", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const identity = root.children().find((child) => child.name() === "identity");

    expect(identity?.children().map((child) => child.name())).toEqual([
      "api-key-credential-provider",
      "oauth2-credential-provider",
    ]);
    expect(
      identity
        ?.children()
        .find((child) => child.name() === "api-key-credential-provider")
        ?.children()
        .map((child) => child.name()),
    ).toEqual(["create", "get", "list", "update", "delete"]);
  });

  test.each(["identity", "identity api-key-credential-provider"])(
    "prints help for `%s --json` without an SDK call",
    async (command) => {
      const stdout = await run([...command.split(" "), "--json"]);

      expect(stdout).toContain(`Usage: agentcore ${command}`);
      expect(stdout).toContain("Commands:");
    },
  );
});

describe("api-key-credential-provider TUI dispatch", () => {
  test.each([
    ["identity", ["identity"]],
    ["api-key-credential-provider", ["identity", "api-key-credential-provider"]],
    ["get", ["identity", "api-key-credential-provider", "get"]],
    ["list", ["identity", "api-key-credential-provider", "list"]],
  ] as const)("opens the TUI for a bare `%s`", async (_label, args) => {
    await expect(run([...args])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
  });

  test.each(["create", "update", "delete"] as const)(
    "runs normal validation for bare CLI-only `%s`",
    async (command) => {
      await expect(run(["identity", "api-key-credential-provider", command])).rejects.toThrow(
        "required option '--name <name>' not specified",
      );
    },
  );
});

describe("api-key-credential-provider CRUDL", () => {
  test("creates an API key credential provider", async () => {
    const stdout = await run(
      [
        "identity",
        "api-key-credential-provider",
        "create",
        "--name",
        FIXTURE_PROVIDER_NAME,
        "--api-key",
        "-",
      ],
      "test-api-key-value",
    );

    matchGolden(FIXTURES, "create.golden.json", stdout);
  });

  test("creates a second API key credential provider for pagination", async () => {
    const stdout = await run(
      [
        "identity",
        "api-key-credential-provider",
        "create",
        "--name",
        FIXTURE_PROVIDER_NAME_2,
        "--api-key",
        "-",
      ],
      "test-api-key-value-2",
    );

    matchGolden(FIXTURES, "create-2.golden.json", stdout);
  });

  test("gets an API key credential provider", async () => {
    const stdout = await run([
      "identity",
      "api-key-credential-provider",
      "get",
      "--name",
      FIXTURE_PROVIDER_NAME,
    ]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout).name).toBe(FIXTURE_PROVIDER_NAME);
  });

  test("lists API key credential providers", async () => {
    const stdout = await run(["identity", "api-key-credential-provider", "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).credentialProviders).toBeArray();
  });

  test("paginates API key credential provider list with --max-results and --next-token", async () => {
    const firstPage = await run([
      "identity",
      "api-key-credential-provider",
      "list",
      "--max-results",
      "1",
    ]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.credentialProviders).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "identity",
      "api-key-credential-provider",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).credentialProviders).toHaveLength(1);
  });

  test("updates an API key credential provider", async () => {
    const stdout = await run(
      [
        "identity",
        "api-key-credential-provider",
        "update",
        "--name",
        FIXTURE_PROVIDER_NAME,
        "--api-key",
        "-",
      ],
      "updated-api-key-value",
    );

    matchGolden(FIXTURES, "update.golden.json", stdout);
    expect(JSON.parse(stdout).name).toBe(FIXTURE_PROVIDER_NAME);
  });

  test("deletes the first API key credential provider", async () => {
    const stdout = await run([
      "identity",
      "api-key-credential-provider",
      "delete",
      "--name",
      FIXTURE_PROVIDER_NAME,
    ]);

    matchGolden(FIXTURES, "delete.golden.json", stdout);
  });

  test("deletes the second API key credential provider", async () => {
    const stdout = await run([
      "identity",
      "api-key-credential-provider",
      "delete",
      "--name",
      FIXTURE_PROVIDER_NAME_2,
    ]);

    matchGolden(FIXTURES, "delete-2.golden.json", stdout);
  });

  test.each([
    [
      "create --name only",
      ["identity", "api-key-credential-provider", "create", "--name", "x"],
      /--api-key.*--api-key-secret-reference/,
    ],
    [
      "create --api-key only",
      ["identity", "api-key-credential-provider", "create", "--api-key", "x"],
      /--name/,
    ],
    [
      "get --json (no name)",
      ["identity", "api-key-credential-provider", "get", "--json"],
      /--name/,
    ],
    [
      "update --name only",
      ["identity", "api-key-credential-provider", "update", "--name", "x"],
      /--api-key.*--api-key-secret-reference/,
    ],
    [
      "delete --json (no name)",
      ["identity", "api-key-credential-provider", "delete", "--json"],
      /--name/,
    ],
  ] as const)("rejects missing required flags for `%s`", async (_label, args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });

  test.each([
    [
      "create: --api-key with --api-key-secret-reference",
      [
        "identity",
        "api-key-credential-provider",
        "create",
        "--name",
        "x",
        "--api-key",
        "k",
        "--api-key-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey"}',
      ],
      /mutually exclusive/,
    ],
    [
      "create: --api-key-secret-reference missing secretId",
      [
        "identity",
        "api-key-credential-provider",
        "create",
        "--name",
        "x",
        "--api-key-secret-reference",
        '{"jsonKey":"apiKey"}',
      ],
      /--api-key-secret-reference/,
    ],
    [
      "create: --api-key-secret-reference with unexpected field",
      [
        "identity",
        "api-key-credential-provider",
        "create",
        "--name",
        "x",
        "--api-key-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey","extra":"bad"}',
      ],
      /--api-key-secret-reference/,
    ],
    [
      "update: --api-key with --api-key-secret-reference",
      [
        "identity",
        "api-key-credential-provider",
        "update",
        "--name",
        "x",
        "--api-key",
        "k",
        "--api-key-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey"}',
      ],
      /mutually exclusive/,
    ],
    [
      "create: --api-key with an inline value",
      [
        "identity",
        "api-key-credential-provider",
        "create",
        "--name",
        "x",
        "--api-key",
        "sk-inline",
      ],
      /file:\/\//,
    ],
  ] as const)("rejects invalid secret input for `%s`", async (_label, args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });

  test("propagates ResourceNotFoundException from get", async () => {
    await expect(
      run(["identity", "api-key-credential-provider", "get", "--name", MISSING_PROVIDER_NAME]),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
