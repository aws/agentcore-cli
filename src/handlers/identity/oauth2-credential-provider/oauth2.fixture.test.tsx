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

// Record with RECORD=1 bun test src/handlers/identity/oauth2-credential-provider/oauth2.fixture.test.tsx
// Neither fixture provider should exist before recording. The RECORD run creates
// both providers, exercises pagination (requires >=2), then deletes
const FIXTURE_PROVIDER_NAME = "agentcore-cli-oauth2-fixture";
const FIXTURE_PROVIDER_NAME_2 = "agentcore-cli-oauth2-fixture-2";
const MISSING_PROVIDER_NAME = "missing-oauth2-provider-000";

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

describe("oauth2-credential-provider CRUDL", () => {
  test("creates an OAuth2 credential provider", async () => {
    const stdout = await run(
      [
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
        "-",
      ],
      "fixture-secret",
    );

    matchGolden(FIXTURES, "create.golden.json", stdout);
  });

  test("creates a second OAuth2 credential provider for pagination", async () => {
    const stdout = await run(
      [
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
        "-",
      ],
      "fixture-secret-2",
    );

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
    const stdout = await run(["identity", "oauth2-credential-provider", "list", "--json"]);

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
    const stdout = await run(
      [
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
        "-",
      ],
      "updated-secret",
    );

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

describe("oauth2-credential-provider fixture-backed errors", () => {
  test("propagates ResourceNotFoundException from get", async () => {
    await expect(
      run(["identity", "oauth2-credential-provider", "get", "--name", MISSING_PROVIDER_NAME]),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
  });
});
