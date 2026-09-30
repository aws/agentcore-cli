import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  waitForText,
} from "../../../../../testing";
import { InputValidationError } from "../../../../../errors";
import type { AppIO } from "../../../../../io";
import { createRootHandler } from "../../../../index";
import { createGatewayProjectTestHarness } from "../../gateway-test-support";
import { OAUTH_VENDOR_CHOICES } from "./screen";

const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness(
  "add-oauth-credential-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function nameCredential(screen: ReturnType<typeof renderScreen>, name = "service-oauth") {
  await waitForText(screen.lastFrame, "what should this credential provider be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "which OAuth2 provider?");
}

async function selectVendor(
  screen: ReturnType<typeof renderScreen>,
  vendor: (typeof OAUTH_VENDOR_CHOICES)[number]["value"],
) {
  const index = OAUTH_VENDOR_CHOICES.findIndex((choice) => choice.value === vendor);
  expect(index).toBeGreaterThanOrEqual(0);
  for (let offset = 1; offset <= index; offset++) {
    await screen.press("down");
    expect(screen.lastFrame()).toContain(`❯ ● ${OAUTH_VENDOR_CHOICES[offset]!.label}`);
  }
  await waitForText(screen.lastFrame, `❯ ● ${vendor}`);
  await screen.press("return");
}

describe("project add credentials oauth wizard", () => {
  test("adds a guided custom provider whose secret comes from a local file", async () => {
    const projectRoot = await inProject();
    const secretPath = join(projectRoot, "oauth-secret.txt");
    const secret = "oauth-secret-never-render-this";
    await writeFile(secretPath, `${secret}\n`);
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await nameCredential(screen);
    expect(screen.lastFrame()).toContain("❯ ● a custom provider");
    expect(screen.lastFrame()).toContain("GithubOauth2");
    await screen.press("return");

    await waitForText(screen.lastFrame, "how is the custom provider configured?");
    await screen.write("client-1");
    await screen.press("return");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");
    await screen.write("openid email");
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "where is the client secret?");
    expect(screen.lastFrame()).toContain("❯ ● in a local file");
    expect(screen.lastFrame()).not.toContain(secret);
    await screen.press("return");
    await waitForText(screen.lastFrame, "which file holds the client secret?");
    await screen.write(secretPath);
    expect(screen.lastFrame()).not.toContain(secret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("credential service-oauth");
    expect(review).toContain("provider a custom provider (CustomOauth2)");
    expect(review).toContain("client ID client-1");
    expect(review).toContain(`discovery URL ${DISCOVERY_URL}`);
    expect(review).toContain("scopes openid, email");
    expect(review).toContain("source local file");
    expect(review.replaceAll(" ", "")).toContain(secretPath);
    expect(review).not.toContain(secret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'service-oauth' to 'TestProject'");
    expect(screen.lastFrame()).not.toContain(secret);
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "service-oauth",
        vendor: "CustomOauth2",
        clientId: "client-1",
        discoveryUrl: DISCOVERY_URL,
        scopes: ["openid", "email"],
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain(`AGENTCORE_CREDENTIAL_SERVICE_OAUTH_CLIENT_SECRET='${secret}'`);
    screen.unmount();
  }, 15000);

  test("adds a vendored provider with JSON configuration and a secret reference", async () => {
    const projectRoot = await inProject();
    const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:github-oauth";
    const providerConfig = {
      githubOauth2ProviderConfig: {
        clientId: "github-client",
      },
    };
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await nameCredential(screen, "github-oauth");
    await selectVendor(screen, "GithubOauth2");

    await waitForText(screen.lastFrame, "what is the provider configuration?");
    expect(screen.lastFrame()).toContain("githubOauth2ProviderConfig");
    await screen.write(JSON.stringify(providerConfig));
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "where is the client secret?");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which secret?");
    await screen.write(secretArn);
    await screen.press("return");
    await screen.write("clientSecret");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("credential github-oauth");
    expect(review).toContain("provider GithubOauth2");
    expect(review).toContain(`provider configuration ${JSON.stringify(providerConfig)}`);
    expect(review).toContain(`secret ARN ${secretArn}`);
    expect(review).toContain("JSON key clientSecret");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'github-oauth'");
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github-oauth",
        vendor: "GithubOauth2",
        providerConfig,
        clientSecretRef: {
          secretId: secretArn,
          jsonKey: "clientSecret",
        },
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_GITHUB_OAUTH_CLIENT_SECRET");
    screen.unmount();
  }, 15000);

  test("allows optional custom client ID and scopes to be omitted", async () => {
    const projectRoot = await inProject();
    const secretPath = join(projectRoot, "oauth-secret.txt");
    await writeFile(secretPath, "secret");
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await nameCredential(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "how is the custom provider configured?");
    await screen.press("return");
    await screen.write(DISCOVERY_URL);
    await screen.press("return");
    await screen.press("return");

    await waitForText(screen.lastFrame, "where is the client secret?");
    await screen.press("return");
    await screen.write(secretPath);
    await screen.press("return");
    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("client ID (none)");
    expect(review).toContain("scopes (none)");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'service-oauth'");
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "service-oauth",
        vendor: "CustomOauth2",
        discoveryUrl: DISCOVERY_URL,
      },
    ]);
    screen.unmount();
  }, 15000);

  test("requires a valid discovery URL for a custom provider", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await nameCredential(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "how is the custom provider configured?");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Discovery URL is required");

    await screen.write("not-a-url");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Must be a valid URL");
    expect(screen.lastFrame()).not.toContain("where is the client secret?");
    screen.unmount();
  });

  test("validates vendored provider configuration before advancing", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await nameCredential(screen);
    await selectVendor(screen, "GithubOauth2");
    await waitForText(screen.lastFrame, "what is the provider configuration?");
    await screen.write('{"githubOauth2ProviderConfig":');
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "Provider configuration is not valid JSON");
    expect(screen.lastFrame()).not.toContain("where is the client secret?");
    screen.unmount();
  });

  test("rejects secret material inside vendored provider configuration", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await nameCredential(screen);
    await selectVendor(screen, "GithubOauth2");
    await screen.write(
      JSON.stringify({
        githubOauth2ProviderConfig: {
          clientId: "github-client",
          clientSecret: "must-not-be-here",
        },
      }),
    );
    await screen.press("ctrl+d");

    await waitForText(screen.lastFrame, "providerConfig must not contain secret material");
    expect(screen.lastFrame()).not.toContain("where is the client secret?");
    screen.unmount();
  });

  test("validates the credential name live", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await waitForText(screen.lastFrame, "what should this credential provider be called?");
    await screen.write("bad name");

    await waitForText(screen.lastFrame, "Must contain only alphanumeric characters");
    screen.unmount();
  });

  test("the long vendor selector remains navigable in an 80x24 terminal", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/oauth");
    await screen.resize(80, 24);

    await nameCredential(screen);
    expect(screen.lastFrame()?.split("\n")).toHaveLength(24);
    expect(screen.lastFrame()).toContain("↓ 15 more");

    await selectVendor(screen, "GithubOauth2");
    await waitForText(screen.lastFrame, "what is the provider configuration?");
    screen.unmount();
  });

  test("esc on the first step returns to the credentials menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/oauth");

    await waitForText(screen.lastFrame, "what should this credential provider be called?");
    await screen.press("escape");

    await waitForText(
      screen.lastFrame,
      "add AgentCore Identity credential providers to the current project",
    );
    screen.unmount();
  });
});

describe("project add credentials oauth dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "credentials", "oauth", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  function expectMissingName(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name");
  }

  test("a bare command in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "credentials", "oauth"])
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

  test.each<[string, () => AppIO, string[]]>([
    ["a bare command without a TTY", () => testIO().io, []],
    ["a user-supplied flag in a TTY", () => ttyTestIO().streams.io, ["--vendor", "GithubOauth2"]],
    ["--json in a TTY", () => ttyTestIO().streams.io, ["--json"]],
  ])("%s stays headless", async (_label, io, args) => {
    await inProject();

    expectMissingName(await routeError(io(), args));
  });

  test("flag-driven add still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const secretPath = join(projectRoot, "flag-oauth-secret.txt");
    await writeFile(secretPath, "flag-secret");
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "credentials",
      "oauth",
      "--name",
      "flag-oauth",
      "--discovery-url",
      DISCOVERY_URL,
      "--client-secret",
      `file://${secretPath}`,
    ]);

    expect((await projectSpec(projectRoot)).credentials).toContainEqual({
      authorizerType: "OAuthCredentialProvider",
      name: "flag-oauth",
      vendor: "CustomOauth2",
      discoveryUrl: DISCOVERY_URL,
    });
  }, 10000);
});
