import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// Record with RECORD=1 bun test src/handlers/identity/oauth2-credential-provider/oauth2.test.tsx
// Neither fixture provider should exist before recording. The RECORD run creates
// both providers, exercises pagination (requires >=2), then deletes
const FIXTURE_PROVIDER_NAME = "agentcore-cli-oauth2-fixture";
const FIXTURE_PROVIDER_NAME_2 = "agentcore-cli-oauth2-fixture-2";
const MISSING_PROVIDER_NAME = "missing-oauth2-provider-000";

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("oauth2-credential-provider command hierarchy", () => {
  test("registers the oauth2-credential-provider command hierarchy", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const identity = root.children().find((child) => child.name() === "identity");
    const oauth2 = identity
      ?.children()
      .find((child) => child.name() === "oauth2-credential-provider");

    expect(oauth2?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "update",
      "delete",
    ]);
  });

  test("prints help for bare `identity oauth2-credential-provider` without an SDK call", async () => {
    const stdout = await run(["identity", "oauth2-credential-provider"]);

    expect(stdout).toContain("Usage: agentcore identity oauth2-credential-provider");
    expect(stdout).toContain("Commands:");
  });
});

describe("oauth2-credential-provider CRUDL", () => {
  test("creates an OAuth2 credential provider", async () => {
    const stdout = await run([
      "identity",
      "oauth2-credential-provider",
      "create",
      "--name",
      FIXTURE_PROVIDER_NAME,
      "--vendor",
      "CustomOauth2",
      "--client-id",
      "fixture-client-id",
      "--discovery-url",
      "https://example.com/.well-known/openid-configuration",
      "--client-secret",
      "fixture-secret",
    ]);

    matchGolden(FIXTURES, "create.golden.json", stdout);
  });

  test("creates a second OAuth2 credential provider for pagination", async () => {
    const stdout = await run([
      "identity",
      "oauth2-credential-provider",
      "create",
      "--name",
      FIXTURE_PROVIDER_NAME_2,
      "--vendor",
      "CustomOauth2",
      "--client-id",
      "fixture-client-id-2",
      "--discovery-url",
      "https://example.com/.well-known/openid-configuration",
      "--client-secret",
      "fixture-secret-2",
    ]);

    matchGolden(FIXTURES, "create-2.golden.json", stdout);
  });

  test("gets an OAuth2 credential provider", async () => {
    const stdout = await run([
      "identity",
      "oauth2-credential-provider",
      "get",
      "--name",
      FIXTURE_PROVIDER_NAME,
    ]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    expect(JSON.parse(stdout).name).toBe(FIXTURE_PROVIDER_NAME);
  });

  test("lists OAuth2 credential providers", async () => {
    const stdout = await run(["identity", "oauth2-credential-provider", "list"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).credentialProviders).toBeArray();
  });

  test("paginates OAuth2 credential provider list with --max-results and --next-token", async () => {
    const firstPage = await run([
      "identity",
      "oauth2-credential-provider",
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
      "oauth2-credential-provider",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).credentialProviders).toHaveLength(1);
  });

  test("updates an OAuth2 credential provider", async () => {
    const stdout = await run([
      "identity",
      "oauth2-credential-provider",
      "update",
      "--name",
      FIXTURE_PROVIDER_NAME,
      "--vendor",
      "CustomOauth2",
      "--client-id",
      "updated-client-id",
      "--discovery-url",
      "https://example.com/.well-known/openid-configuration",
      "--client-secret",
      "updated-secret",
    ]);

    matchGolden(FIXTURES, "update.golden.json", stdout);
    expect(JSON.parse(stdout).name).toBe(FIXTURE_PROVIDER_NAME);
  });

  test("deletes the first OAuth2 credential provider", async () => {
    const stdout = await run([
      "identity",
      "oauth2-credential-provider",
      "delete",
      "--name",
      FIXTURE_PROVIDER_NAME,
    ]);

    matchGolden(FIXTURES, "delete.golden.json", stdout);
  });

  test("deletes the second OAuth2 credential provider", async () => {
    const stdout = await run([
      "identity",
      "oauth2-credential-provider",
      "delete",
      "--name",
      FIXTURE_PROVIDER_NAME_2,
    ]);

    matchGolden(FIXTURES, "delete-2.golden.json", stdout);
  });
});

describe("oauth2-credential-provider flag validation", () => {
  test.each([
    [
      "create --name only",
      ["identity", "oauth2-credential-provider", "create", "--name", "x"],
      /--vendor/,
    ],
    [
      "create --name + --vendor only",
      [
        "identity",
        "oauth2-credential-provider",
        "create",
        "--name",
        "x",
        "--vendor",
        "CustomOauth2",
      ],
      /--client-secret.*--client-secret-reference/,
    ],
    ["create bare", ["identity", "oauth2-credential-provider", "create"], /--name/],
    ["get bare", ["identity", "oauth2-credential-provider", "get"], /--name/],
    ["update bare", ["identity", "oauth2-credential-provider", "update"], /--name/],
    ["delete bare", ["identity", "oauth2-credential-provider", "delete"], /--name/],
  ] as const)("rejects missing required flags for `%s`", async (_label, args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });

  test.each([
    [
      "create: --client-secret with --client-secret-reference",
      [
        "identity",
        "oauth2-credential-provider",
        "create",
        "--name",
        "x",
        "--vendor",
        "CustomOauth2",
        "--client-secret",
        "s",
        "--client-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"k"}',
      ],
      /mutually exclusive/,
    ],
    [
      "create: --provider-configuration with guided flags",
      [
        "identity",
        "oauth2-credential-provider",
        "create",
        "--name",
        "x",
        "--vendor",
        "CustomOauth2",
        "--client-secret",
        "s",
        "--client-id",
        "c",
        "--provider-configuration",
        '{"customOauth2ProviderConfig":{"clientId":"c"}}',
      ],
      /mutually exclusive/,
    ],
    [
      "create: --discovery-url with --authorization-server-metadata",
      [
        "identity",
        "oauth2-credential-provider",
        "create",
        "--name",
        "x",
        "--vendor",
        "CustomOauth2",
        "--client-secret",
        "s",
        "--discovery-url",
        "https://example.com",
        "--authorization-server-metadata",
        '{"issuer":"https://example.com"}',
      ],
      /mutually exclusive/,
    ],
  ] as const)("rejects mutually exclusive flags for `%s`", async (_label, args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });

  test("propagates ResourceNotFoundException from get", async () => {
    await expect(
      run(["identity", "oauth2-credential-provider", "get", "--name", MISSING_PROVIDER_NAME]),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
