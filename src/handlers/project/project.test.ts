import { afterEach, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { InputValidationError } from "../../errors";

async function run(args: string[], opts?: { core?: TestCoreClient; stdin?: string }) {
  const io = testIO({ stdin: opts?.stdin });
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

describe.each(["remove", "deploy", "status"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
});

test("project dev requires an AgentCore project", async () => {
  await inTempDirectory();
  await expect(run(["dev"])).rejects.toThrow(/No AgentCore project found/);
});

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project and cds into it so withProject resolves it. */
async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project create", () => {
  test("scaffolds the project into a fresh directory named for the project", async () => {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent"]);

    // One existence check proves the handler→manager pipe; the full manifest
    // is covered by the FsProjectManager snapshot test.
    const projectRoot = join(directory, "MyAgent");
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).exists()).toBe(true);
  });

  test("rejects an invalid --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "1-bad"])).rejects.toThrow();
  });

  test("rejects a reserved --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "test"])).rejects.toThrow(/conflicts with/);
  });

  test("runs the post-scaffold steps and reports progress on stderr", async () => {
    const directory = await inTempDirectory();
    const { io, core } = await run(["create", "--name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello-world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
    expect(io.stderr()).toContain("Creating project tree");
    expect(io.stderr()).toContain("Installing CDK dependencies with npm");
    expect(io.stderr()).toContain("Syncing Python dependencies with uv");
    expect(io.stderr()).toContain("Initializing git repository");
    expect(io.stderr()).toContain("Created project 'MyAgent' in ./MyAgent");
  });

  test("--skip-install and --skip-git run no commands", async () => {
    await inTempDirectory();
    const { core } = await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    expect(core.projectCommands).toEqual([]);
  });

  test("rejects an unknown --template value", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "MyAgent", "--template", "nonsense"])).rejects.toThrow();
  });
});

describe("project add config-bundle", () => {
  const components = {
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent": {
      configuration: {
        systemPrompt: "Help customers with their orders.",
        temperature: 0.2,
      },
    },
  };

  test("adds a configuration bundle to agentcore.json", async () => {
    const projectRoot = await inProject();
    const { io } = await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles).toEqual([
      {
        name: "OrdersConfig",
        type: "ConfigurationBundle",
        components,
        branchName: "mainline",
      },
    ]);
    expect(io.stderr()).toContain("added configuration bundle 'OrdersConfig' to 'TestProject'");
  });

  test("stores optional configuration bundle fields", async () => {
    const projectRoot = await inProject();
    const kmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--description",
      "Configuration for the order support runtime",
      "--components",
      JSON.stringify(components),
      "--branch-name",
      "production",
      "--commit-message",
      "Add the initial order support configuration",
      "--kms-key-arn",
      kmsKeyArn,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0]).toEqual({
      name: "OrdersConfig",
      type: "ConfigurationBundle",
      description: "Configuration for the order support runtime",
      components,
      branchName: "production",
      commitMessage: "Add the initial order support configuration",
      kmsKeyArn,
    });
  });

  test("reads components from a file", async () => {
    const projectRoot = await inProject();
    const componentsPath = join(projectRoot, "components.json");
    await Bun.write(componentsPath, JSON.stringify(components));

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      `file://${componentsPath}`,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0].components).toEqual(components);
  });

  test("adds no files under app", async () => {
    const projectRoot = await inProject();

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    expect(existsSync(join(projectRoot, "app", "OrdersConfig"))).toBe(false);
  });

  test("rejects a duplicate configuration bundle name", async () => {
    await inProject();
    const args = [
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ];

    await run(args);
    await expect(run(args)).rejects.toBeInstanceOf(InputValidationError);
  });

  test.each([
    ["missing name", ["--components", JSON.stringify(components)]],
    ["missing components", ["--name", "OrdersConfig"]],
    ["invalid name", ["--name", "orders-config", "--components", JSON.stringify(components)]],
    ["empty components", ["--name", "OrdersConfig", "--components", "{}"]],
    [
      "component without configuration",
      ["--name", "OrdersConfig", "--components", '{"arn:component":{}}'],
    ],
    [
      "non-object component configuration",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":"not-an-object"}}',
      ],
    ],
    [
      "unexpected component field",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":{},"unexpected":true}}',
      ],
    ],
    ["malformed components", ["--name", "OrdersConfig", "--components", "{not-json"]],
    [
      "empty description",
      ["--name", "OrdersConfig", "--description", "", "--components", JSON.stringify(components)],
    ],
    [
      "branch name above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--branch-name",
        "b".repeat(129),
      ],
    ],
    [
      "commit message above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--commit-message",
        "m".repeat(501),
      ],
    ],
    [
      "invalid KMS key ARN",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--kms-key-arn",
        "not-an-arn",
      ],
    ],
  ])("rejects %s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "config-bundle", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});

describe("project add credentials", () => {
  test("api-key with a file:// secret records the spec entry and stores the trailing-newline-stripped key in .env.local", async () => {
    const projectRoot = await inProject();
    const keyPath = join(projectRoot, "key.txt");
    // The trailing newline mirrors `echo` and editor output; it must not reach the value.
    await Bun.write(keyPath, "sk-123\n");

    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key",
      `file://${keyPath}`,
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key" },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY='sk-123'\n");
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SVC_KEY='sk-123'\n\n");
  });

  test("api-key without a secret writes a commented placeholder and tells the user to fill it", async () => {
    const projectRoot = await inProject();
    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("# API key for credential provider 'svc-key' (set before deploy)");
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=\n");
    expect(io.stderr()).toContain(
      "Set AGENTCORE_CREDENTIAL_SVC_KEY in agentcore/.env.local before you deploy",
    );
  });

  test("api-key with an external secret reference records it in the spec and skips .env.local", async () => {
    const projectRoot = await inProject();
    const secretRef = {
      secretId: "arn:aws:secretsmanager:us-west-2:123456789012:secret:s",
      jsonKey: "apiKey",
    };

    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "svc-key",
      "--api-key-secret-reference",
      JSON.stringify(secretRef),
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "svc-key", secretRef },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SVC_KEY");
  });

  const discoveryUrl = "https://idp.example.com/.well-known/openid-configuration";

  test("oauth custom with guided flags and a stdin secret records the spec entry and the secret", async () => {
    const projectRoot = await inProject();

    await run(
      [
        "add",
        "credentials",
        "oauth",
        "--name",
        "idp",
        "--discovery-url",
        discoveryUrl,
        "--client-id",
        "client-1",
        "--scopes",
        "openid",
        "email",
        "--client-secret",
        "-",
      ],
      { stdin: "sssh" },
    );

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "idp",
        vendor: "CustomOauth2",
        clientId: "client-1",
        discoveryUrl,
        scopes: ["openid", "email"],
      },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_IDP_CLIENT_SECRET='sssh'");
  });

  test("oauth vendored with --provider-configuration records the config and a secret placeholder", async () => {
    const projectRoot = await inProject();

    const { io } = await run([
      "add",
      "credentials",
      "oauth",
      "--name",
      "github",
      "--vendor",
      "GithubOauth2",
      "--provider-configuration",
      '{"githubOauth2ProviderConfig":{"clientId":"client-1"}}',
    ]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "OAuthCredentialProvider",
        name: "github",
        vendor: "GithubOauth2",
        providerConfig: { githubOauth2ProviderConfig: { clientId: "client-1" } },
      },
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET=\n");
    expect(io.stderr()).toContain(
      "Set AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET in agentcore/.env.local before you deploy",
    );
  });

  test("preserves existing .env.local content and never overwrites an existing key", async () => {
    const projectRoot = await inProject();
    const envPath = join(projectRoot, "agentcore", ".env.local");
    const original = await Bun.file(envPath).text();
    await Bun.write(envPath, `${original}AGENTCORE_CREDENTIAL_SVC_KEY=user-managed\n`);

    const { io } = await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(envPath).text();
    expect(env).toStartWith(original);
    expect(env.match(/AGENTCORE_CREDENTIAL_SVC_KEY=/g)).toHaveLength(1);
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=user-managed");
    expect(io.stderr()).toContain("already exists");
  });

  test("creates .env.local when the project lacks one", async () => {
    const projectRoot = await inProject();
    const envPath = join(projectRoot, "agentcore", ".env.local");
    await rm(envPath);

    await run(["add", "credentials", "api-key", "--name", "svc-key"]);

    const env = await Bun.file(envPath).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_SVC_KEY=\n");
  });

  test("rejects a duplicate credential name across credential types", async () => {
    await inProject();
    await run(["add", "credentials", "api-key", "--name", "dup"]);
    await expect(
      run(["add", "credentials", "oauth", "--name", "dup", "--discovery-url", discoveryUrl]),
    ).rejects.toThrow(/already exists/);
  });

  test("rejects two names that derive the same environment variable", async () => {
    await inProject();
    await run(["add", "credentials", "api-key", "--name", "svc-key"]);
    await expect(run(["add", "credentials", "api-key", "--name", "svc_key"])).rejects.toThrow(
      /same environment variable/,
    );
  });

  test.each<[string, string[], RegExp]>([
    [
      "api-key: an inline secret value",
      ["api-key", "--name", "x", "--api-key", "sk-inline"],
      /file:\/\//,
    ],
    ["api-key: a multi-line secret", ["api-key", "--name", "x", "--api-key", "-"], /single-line/],
    [
      "oauth: an inline secret value",
      ["oauth", "--name", "x", "--discovery-url", discoveryUrl, "--client-secret", "sssh"],
      /file:\/\//,
    ],
    [
      "api-key: a secret combined with a secret reference",
      [
        "api-key",
        "--name",
        "x",
        "--api-key",
        "-",
        "--api-key-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey"}',
      ],
      /mutually exclusive/,
    ],
    [
      "oauth: a secret combined with a secret reference",
      [
        "oauth",
        "--name",
        "x",
        "--discovery-url",
        discoveryUrl,
        "--client-secret",
        "-",
        "--client-secret-reference",
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"clientSecret"}',
      ],
      /mutually exclusive/,
    ],
    ["api-key: a missing --name", ["api-key"], /--name/],
    ["oauth: a missing --name", ["oauth"], /--name/],
    [
      "oauth: a vendored provider without --provider-configuration",
      ["oauth", "--name", "x", "--vendor", "GithubOauth2"],
      /--provider-configuration/,
    ],
    [
      "oauth: a guided custom provider without --discovery-url",
      ["oauth", "--name", "x", "--client-id", "c"],
      /--discovery-url/,
    ],
    [
      "oauth: --provider-configuration combined with --scopes",
      [
        "oauth",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--provider-configuration",
        '{"githubOauth2ProviderConfig":{"clientId":"c"}}',
        "--scopes",
        "repo",
      ],
      /mutually exclusive/,
    ],
    [
      "oauth: secret material inside --provider-configuration",
      [
        "oauth",
        "--name",
        "x",
        "--vendor",
        "GithubOauth2",
        "--provider-configuration",
        '{"githubOauth2ProviderConfig":{"clientId":"c","clientSecret":"sssh"}}',
      ],
      /secret material/,
    ],
  ])("rejects %s", async (_label, args, message) => {
    await inProject();
    await expect(run(["add", "credentials", ...args], { stdin: "line1\nline2" })).rejects.toThrow(
      message,
    );
  });
});

describe("project build", () => {
  async function inBuildableProject(): Promise<string> {
    const projectRoot = await inProject("MyAgent");
    // create --skip-install leaves no node_modules, which build requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    return projectRoot;
  }

  test("synthesizes the CDK app of the enclosing project", async () => {
    const projectRoot = await inBuildableProject();
    const { io, core } = await run(["build"]);

    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "run", "cdk", "--", "synth", "--quiet"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
    ]);
    expect(io.stderr()).toContain("Synthesizing CloudFormation templates");
    expect(io.stderr()).toContain("Built project 'MyAgent'");
  });

  test("resolves the project from a nested directory", async () => {
    const projectRoot = await inBuildableProject();
    process.chdir(join(projectRoot, "app", "hello-world"));

    const { core } = await run(["build"]);

    expect(core.projectCommands.map(({ cwd }) => cwd)).toEqual([
      join(projectRoot, "agentcore", "cdk"),
    ]);
  });

  test("fails with actionable guidance outside a project", async () => {
    await inTempDirectory();
    await expect(run(["build"])).rejects.toThrow(/No AgentCore project found/);
  });

  test("fails when the CDK dependencies have not been installed", async () => {
    const projectRoot = await inBuildableProject();
    await rm(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });

    await expect(run(["build"])).rejects.toThrow(/npm install/);
  });
});
