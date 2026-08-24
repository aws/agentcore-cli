import { describe, expect, test } from "bun:test";
import type {
  CustomOauth2ProviderConfigOutput,
  GetOauth2CredentialProviderResponse,
  UpdateOauth2CredentialProviderRequest,
  UpdateOauth2CredentialProviderResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";
import {
  buildProviderConfigInput,
  parseProviderConfigFlags,
  validateProviderConfigMode,
} from "./config";

const REGION = "us-west-2";
const PROVIDER_NAME = "oauth2-provider";

const EXISTING_CUSTOM_CONFIG: CustomOauth2ProviderConfigOutput = {
  oauthDiscovery: {
    discoveryUrl: "https://example.com/.well-known/openid-configuration",
  },
  clientId: "existing-client-id",
  onBehalfOfTokenExchangeConfig: {
    grantType: "TOKEN_EXCHANGE",
    tokenExchangeGrantTypeConfig: {
      actorTokenContent: "NONE",
    },
  },
  clientAuthenticationMethod: "CLIENT_SECRET_BASIC",
  privateEndpoint: {
    selfManagedLatticeResource: {
      resourceConfigurationIdentifier: "resource-config",
    },
  },
  privateEndpointOverrides: [
    {
      domain: "token.example.com",
      privateEndpoint: {
        selfManagedLatticeResource: {
          resourceConfigurationIdentifier: "override-resource-config",
        },
      },
    },
  ],
};

const EXISTING_CUSTOM_RESPONSE = {
  name: PROVIDER_NAME,
  credentialProviderVendor: "CustomOauth2",
  clientSecretSource: "MANAGED",
  oauth2ProviderConfigOutput: {
    customOauth2ProviderConfig: EXISTING_CUSTOM_CONFIG,
  },
} as GetOauth2CredentialProviderResponse;

const UPDATE_RESPONSE = {
  name: PROVIDER_NAME,
  credentialProviderVendor: "CustomOauth2",
} as UpdateOauth2CredentialProviderResponse;

async function run(
  args: string[],
  core = new TestCoreClient(),
  stdin?: string,
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

describe("oauth2-credential-provider command hierarchy", () => {
  test("registers the oauth2-credential-provider command hierarchy", () => {
    const root = createRootHandler(new TestCoreClient(), {
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

  test("prints help for `identity oauth2-credential-provider --json` without an SDK call", async () => {
    const { core, stdout } = await run(["identity", "oauth2-credential-provider", "--json"]);

    expect(stdout).toContain("Usage: agentcore identity oauth2-credential-provider");
    expect(stdout).toContain("Commands:");
    expect(core.identity.calls).toEqual([]);
  });
});

describe("oauth2-credential-provider TUI dispatch", () => {
  test.each([
    ["oauth2-credential-provider", ["identity", "oauth2-credential-provider"]],
    ["get", ["identity", "oauth2-credential-provider", "get"]],
    ["list", ["identity", "oauth2-credential-provider", "list"]],
  ] as const)("opens the TUI for a bare `%s`", async (_label, args) => {
    await expect(run([...args])).rejects.toThrow(
      "interactive mode requires a TTY on stdin and stdout",
    );
  });

  test.each(["create", "update", "delete"] as const)(
    "runs normal validation for bare CLI-only `%s`",
    async (command) => {
      await expect(run(["identity", "oauth2-credential-provider", command])).rejects.toThrow(
        "required option '--name <name>' not specified",
      );
    },
  );
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
    ["get --json (no name)", ["identity", "oauth2-credential-provider", "get", "--json"], /--name/],
    [
      "delete --json (no name)",
      ["identity", "oauth2-credential-provider", "delete", "--json"],
      /--name/,
    ],
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
    [
      "update: --provider-configuration with guided flags",
      [
        "identity",
        "oauth2-credential-provider",
        "update",
        "--name",
        "x",
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
      "update: --discovery-url with --authorization-server-metadata",
      [
        "identity",
        "oauth2-credential-provider",
        "update",
        "--name",
        "x",
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

  test.each([
    [
      "create: non-Custom vendor without --provider-configuration",
      [
        "identity",
        "oauth2-credential-provider",
        "create",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--client-secret",
        "s",
      ],
      /--provider-configuration is required for --vendor GithubOauth2/,
    ],
    [
      "create: guided Custom without --discovery-url or --authorization-server-metadata",
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
      ],
      /requires one of --discovery-url or --authorization-server-metadata/,
    ],
    [
      "create: --client-secret with an inline value",
      [
        "identity",
        "oauth2-credential-provider",
        "create",
        "--name",
        "x",
        "--vendor",
        "CustomOauth2",
        "--discovery-url",
        "https://example.com",
        "--client-secret",
        "s-inline",
      ],
      /file:\/\//,
    ],
  ] as const)("enforces vendor/config-mode rules for `%s`", async (_label, args, message) => {
    expect(run([...args])).rejects.toThrow(message);
  });
});

describe("OAuth2 update configuration", () => {
  test("preserves advanced settings during a guided update", () => {
    const mode = parseProviderConfigFlags({ clientId: "updated-client-id" });

    validateProviderConfigMode(mode, "CustomOauth2", EXISTING_CUSTOM_CONFIG);
    const result = buildProviderConfigInput(mode, {
      existingCustomConfig: EXISTING_CUSTOM_CONFIG,
      secret: {
        clientSecret: "updated-secret",
        clientSecretSource: "MANAGED",
      },
    });

    expect(result.customOauth2ProviderConfig).toEqual({
      ...EXISTING_CUSTOM_CONFIG,
      clientId: "updated-client-id",
      clientSecret: "updated-secret",
      clientSecretSource: "MANAGED",
    });
  });

  test("rejects guided updates for non-Custom providers", () => {
    const mode = parseProviderConfigFlags({ clientId: "updated-client-id" });

    expect(() => validateProviderConfigMode(mode, "GithubOauth2")).toThrow(
      /--provider-configuration is required for --vendor GithubOauth2/,
    );
  });

  test("requires discovery when an existing Custom config cannot provide it", () => {
    const mode = parseProviderConfigFlags({ clientId: "updated-client-id" });
    const existingConfig = {
      oauthDiscovery: undefined,
      clientId: "existing-client-id",
    };

    expect(() => validateProviderConfigMode(mode, "CustomOauth2", existingConfig)).toThrow(
      /requires one of --discovery-url or --authorization-server-metadata/,
    );
  });

  test("overrides discovery without dropping unrelated settings", () => {
    const mode = parseProviderConfigFlags({
      discoveryUrl: "https://new.example.com/.well-known/openid-configuration",
    });
    const result = buildProviderConfigInput(mode, {
      existingCustomConfig: EXISTING_CUSTOM_CONFIG,
      secret: {
        clientSecret: "updated-secret",
        clientSecretSource: "MANAGED",
      },
    });

    expect(result.customOauth2ProviderConfig).toEqual({
      ...EXISTING_CUSTOM_CONFIG,
      oauthDiscovery: {
        discoveryUrl: "https://new.example.com/.well-known/openid-configuration",
      },
      clientSecret: "updated-secret",
      clientSecretSource: "MANAGED",
    });
  });

  test("injects secrets into a matching complete configuration", () => {
    const mode = parseProviderConfigFlags({
      providerConfiguration: '{"githubOauth2ProviderConfig":{"clientId":"new-client-id"}}',
    });

    validateProviderConfigMode(mode, "GithubOauth2");
    const result = buildProviderConfigInput(mode, {
      secret: {
        clientSecret: "updated-secret",
        clientSecretSource: "MANAGED",
      },
    });

    expect(result).toEqual({
      githubOauth2ProviderConfig: {
        clientId: "new-client-id",
        clientSecret: "updated-secret",
        clientSecretSource: "MANAGED",
      },
    });
  });
});

describe("OAuth2 complete provider configuration", () => {
  test.each([
    "null",
    "[]",
    "{}",
    '{"githubOauth2ProviderConfig":null}',
    '{"customOauth2ProviderConfig":{},"githubOauth2ProviderConfig":{}}',
  ])("rejects malformed configuration `%s`", (providerConfiguration) => {
    expect(() => parseProviderConfigFlags({ providerConfiguration })).toThrow(
      /single vendor config object/,
    );
  });

  test("leaves create vendor and configuration compatibility to the service", () => {
    const mode = parseProviderConfigFlags({
      providerConfiguration: '{"githubOauth2ProviderConfig":{"clientId":"client-id"}}',
    });

    expect(() => validateProviderConfigMode(mode, "CustomOauth2")).not.toThrow();
  });
});

describe("OAuth2 update handler", () => {
  test("rejects attempts to change the existing vendor before update", async () => {
    const core = new TestCoreClient();
    core.identity.setGetOauth2Response(EXISTING_CUSTOM_RESPONSE);

    await expect(
      run(
        [
          "identity",
          "oauth2-credential-provider",
          "update",
          "--name",
          PROVIDER_NAME,
          "--vendor",
          "GithubOauth2",
          "--client-secret",
          "updated-secret",
        ],
        core,
      ),
    ).rejects.toThrow(/--vendor cannot be changed.*CustomOauth2.*GithubOauth2/);

    expect(core.identity.calls).toEqual([
      {
        method: "getOauth2CredentialProvider",
        args: [PROVIDER_NAME, { region: REGION }],
      },
    ]);
  });

  test("rejects complete configuration for a different provider type", async () => {
    const core = new TestCoreClient();
    core.identity.setGetOauth2Response(EXISTING_CUSTOM_RESPONSE);

    await expect(
      run(
        [
          "identity",
          "oauth2-credential-provider",
          "update",
          "--name",
          PROVIDER_NAME,
          "--client-secret",
          "updated-secret",
          "--provider-configuration",
          '{"githubOauth2ProviderConfig":{"clientId":"updated-client-id"}}',
        ],
        core,
      ),
    ).rejects.toThrow(/must use "customOauth2ProviderConfig"/);

    expect(core.identity.calls).toEqual([
      {
        method: "getOauth2CredentialProvider",
        args: [PROVIDER_NAME, { region: REGION }],
      },
    ]);
  });

  test.each([
    ["omitted", []],
    ["matching", ["--vendor", "CustomOauth2"]],
  ] as const)("preserves the existing config when --vendor is %s", async (_label, vendorArgs) => {
    const core = new TestCoreClient();
    core.identity
      .setGetOauth2Response(EXISTING_CUSTOM_RESPONSE)
      .setUpdateOauth2Response(UPDATE_RESPONSE);

    const { stdout } = await run(
      [
        "identity",
        "oauth2-credential-provider",
        "update",
        "--name",
        PROVIDER_NAME,
        ...vendorArgs,
        "--client-secret",
        "-",
      ],
      core,
      "updated-secret",
    );

    const updateCall = core.identity.calls[1];
    const request = updateCall?.args[0] as UpdateOauth2CredentialProviderRequest;
    expect(core.identity.calls.map((call) => call.method)).toEqual([
      "getOauth2CredentialProvider",
      "updateOauth2CredentialProvider",
    ]);
    expect(request).toEqual({
      name: PROVIDER_NAME,
      credentialProviderVendor: "CustomOauth2",
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          ...EXISTING_CUSTOM_CONFIG,
          clientSecret: "updated-secret",
          clientSecretConfig: undefined,
          clientSecretSource: "MANAGED",
        },
      },
    });
    expect(JSON.parse(stdout)).toEqual(UPDATE_RESPONSE);
  });
});
