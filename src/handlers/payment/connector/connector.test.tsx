import { describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  CreatePaymentConnectorCommand,
  GetPaymentConnectorCommand,
  GetPaymentCredentialProviderCommand,
  UpdatePaymentConnectorCommand,
  type BedrockAgentCoreControlClient,
  type CreatePaymentConnectorResponse,
  type GetPaymentConnectorResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import type { ClientConfig } from "../../../core/types";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  parse,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import quickCreateFixture from "../__fixtures__/connector/CreatePaymentConnectorCommand.3a23138a2103205b.json";

// End-to-end command-flow tests for the `payment connector` leaves.
//
// Each test builds the real root handler over a real CoreClient whose SDK
// clients are the fixture-backed fakes, then drives it through `route()` exactly
// as the CLI does, so one test covers parsing, middleware, the leaf handler,
// PaymentClient (including its credential-provider lookup in identity), and the
// rendered output.
//
// Record with:
//   RECORD=1 AWS_PROFILE=deploy bun test src/handlers/payment/connector/connector.test.tsx
// The flows use a payment manager and a CoinbaseCDP payment credential provider
// that already exist in the test account (the account's manager quota is
// exhausted, so none is created here). The manual flow creates a connector named
// AgentCoreCliConnectorE2E from the named provider, updates it, and deletes it;
// the Quick Create flow creates AgentCoreCliQuickE2E and deletes it without
// completing the OAuth consent.

const FIXTURES = join(import.meta.dir, "..", "__fixtures__", "connector");
// A fixture is keyed by operation and request, and every `get` of one connector
// sends the same request, so the readiness polls and the post-delete not-found
// reads would overwrite each other. The post-delete reads record to a sibling
// directory so both settled states replay.
const AFTER_DELETE_FIXTURES = join(FIXTURES, "after-delete");
const REGION = "us-west-2";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const CREDENTIAL_PROVIDER = "MyPaymentManagerAidandal-MyCdpConnectorAidandal-cdp";
const MANUAL_NAME = "AgentCoreCliConnectorE2E";
const QUICK_NAME = "AgentCoreCliQuickE2E";
// Generous timeouts: in record mode, readiness polls wait on real control-plane
// transitions. Replay never sleeps.
const FLOW_TIMEOUT = 600_000;

function createFixtureCore(dir = FIXTURES): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(dir);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

// createFakedControlCore swaps the control plane's `.send()` for `send` while
// keeping the real CoreClient and PaymentClient in the loop. Used for connector
// states a recording cannot reach on demand (an expired consent window).
function createFakedControlCore(send: (command: unknown) => Promise<unknown>): CoreClient {
  const { createDataClient, createIamClient, createLogsClient } = fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient: () => ({ send }) as unknown as BedrockAgentCoreControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

function createRoot(core = createFixtureCore()) {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return { root, io };
}

async function runCapturing(
  args: string[],
  core?: CoreClient,
): Promise<{ stdout: string; stderr: string }> {
  const { root, io } = createRoot(core);
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { stdout: io.stdout(), stderr: io.stderr() };
}

async function run(args: string[], core?: CoreClient): Promise<string> {
  return (await runCapturing(args, core)).stdout;
}

// pollUntil re-runs `command` until `done(parsed output)` is true. Polling only
// sleeps in record mode; in replay the fixture already holds the settled state
// (the last recorded poll), so the first read satisfies `done`.
async function pollUntil(command: string[], done: (output: any) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const parsed = JSON.parse(await run(command));
    if (done(parsed)) return;
    if (!isRecording()) {
      throw new Error(
        `Replayed fixture for \`${command.join(" ")}\` is not in the awaited state; re-record.`,
      );
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for \`${command.join(" ")}\``);
}

// pollUntilGone re-runs a `get` until the service reports the resource missing.
async function pollUntilGone(command: string[]): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await run(command, createFixtureCore(AFTER_DELETE_FIXTURES));
    } catch (error) {
      if (/ResourceNotFound|not found/i.test((error as Error).message)) return;
      throw error;
    }
    if (!isRecording()) {
      throw new Error(`Replayed fixture for \`${command.join(" ")}\` still exists; re-record.`);
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`Timed out waiting for \`${command.join(" ")}\` to disappear`);
}

describe("payment connector command hierarchy", () => {
  test("registers the five connector leaves", () => {
    const { root } = createRoot();
    const connector = root
      .children()
      .find((child) => child.name() === "payment")
      ?.children()
      .find((child) => child.name() === "connector");

    expect(connector?.children().map((child) => child.name())).toEqual([
      "create",
      "get",
      "list",
      "update",
      "delete",
    ]);
  });
});

describe("payment connector flag validation", () => {
  test.each([
    ["create", "name"],
    ["create", "ARN"],
    ["update", "name"],
    ["update", "ARN"],
  ] as const)("`%s` accepts a credential-provider %s", async (command, referenceType) => {
    const providerArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/paymentcredentialprovider/provider";
    const commands: unknown[] = [];
    const core = createFakedControlCore(async (request) => {
      commands.push(request);
      if (request instanceof GetPaymentCredentialProviderCommand) {
        expect(request.input.name).toBe(CREDENTIAL_PROVIDER);
        return {
          credentialProviderArn: providerArn,
          credentialProviderVendor: "CoinbaseCDP",
        };
      }
      if (request instanceof GetPaymentConnectorCommand) return connectorDetail("READY");
      if (
        request instanceof CreatePaymentConnectorCommand ||
        request instanceof UpdatePaymentConnectorCommand
      ) {
        return connectorDetail("READY");
      }
      throw new Error("unexpected SDK command");
    });

    await run(
      [
        "payment",
        "connector",
        command,
        "--manager-id",
        MANAGER_ID,
        ...(command === "create" ? ["--name", MANUAL_NAME] : ["--connector-id", "c-1"]),
        ...(command === "create" && referenceType === "ARN" ? ["--type", "CoinbaseCDP"] : []),
        "--credential-provider",
        referenceType === "ARN" ? providerArn : CREDENTIAL_PROVIDER,
      ],
      core,
    );

    expect(commands).toEqual([
      ...(command === "update" ? [expect.any(GetPaymentConnectorCommand)] : []),
      ...(referenceType === "name" ? [expect.any(GetPaymentCredentialProviderCommand)] : []),
      expect.any(
        command === "create" ? CreatePaymentConnectorCommand : UpdatePaymentConnectorCommand,
      ),
    ]);
    expect(commands.at(-1)).toMatchObject({
      input: {
        credentialProviderConfigurations: [{ coinbaseCDP: { credentialProviderArn: providerArn } }],
      },
    });
  });

  test.each(["create", "update"] as const)(
    "`%s` rejects empty --credential-provider before Core or SDK calls",
    async (command) => {
      const factories = fixtureFactories(FIXTURES);
      const sdk = mock(() => {
        throw new Error("unexpected SDK client creation");
      });
      for (const name of Object.keys(factories) as (keyof typeof factories)[]) {
        spyOn(factories, name).mockImplementation(sdk);
      }
      const core = new CoreClient({ ...factories, logger: createSilentLogger() });
      const call = spyOn(
        core.payment,
        command === "create" ? "createPaymentConnector" : "updatePaymentConnector",
      );
      const { root, io } = createRoot(core);

      try {
        await expect(
          root.route([
            "node",
            "agentcore",
            "payment",
            "connector",
            command,
            "--manager-id",
            MANAGER_ID,
            ...(command === "create" ? ["--name", "EmptyReference"] : ["--connector-id", "c-1"]),
            "--credential-provider",
            "",
            "--region",
            REGION,
          ]),
        ).rejects.toThrow("Invalid value for option '--credential-provider'");
        expect(call).not.toHaveBeenCalled();
        expect(sdk).not.toHaveBeenCalled();
        expect(io.stdout()).toBe("");
        expect(io.stderr()).toBe("");
      } finally {
        call.mockRestore();
      }
    },
  );

  // Each leaf declares its identifying flags optional (so a bare invocation can
  // fall through to the TUI once one exists) but requires them at runtime. None
  // of these reach the SDK, so no fixtures are involved.
  test("`create` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "create", "--manager-id", "", "--name", "X", "--quick-create"]),
    ).rejects.toThrow("required option '--manager-id <manager-id>' not specified");
  });

  test("`create` errors when --name is omitted", async () => {
    await expect(
      run([
        "payment",
        "connector",
        "create",
        "--manager-id",
        "m-1",
        "--name",
        "",
        "--quick-create",
      ]),
    ).rejects.toThrow("required option '--name <name>' not specified");
  });

  test("`create` rejects --quick-create together with --credential-provider", async () => {
    await expect(
      run([
        "payment",
        "connector",
        "create",
        "--manager-id",
        "m-1",
        "--name",
        "Both",
        "--quick-create",
        "--credential-provider",
        "some-provider",
      ]),
    ).rejects.toThrow("specify exactly one of '--quick-create' or '--credential-provider'");
  });

  test("`create` rejects neither --quick-create nor --credential-provider", async () => {
    await expect(
      run(["payment", "connector", "create", "--manager-id", "m-1", "--name", "Neither"]),
    ).rejects.toThrow("specify exactly one of '--quick-create' or '--credential-provider'");
  });

  test("`create` rejects an unsupported --type", async () => {
    await expect(
      run([
        "payment",
        "connector",
        "create",
        "--manager-id",
        "m-1",
        "--name",
        "Bad",
        "--type",
        "Paypal",
        "--quick-create",
      ]),
    ).rejects.toThrow(/Invalid value for option '--type'/);
  });

  test("`create --type StripePrivy --quick-create` surfaces the Core validation error", async () => {
    await expect(
      run([
        "payment",
        "connector",
        "create",
        "--manager-id",
        "m-1",
        "--name",
        "Stripe",
        "--type",
        "StripePrivy",
        "--quick-create",
      ]),
    ).rejects.toThrow("Quick Create is available only for CoinbaseCDP connectors, not StripePrivy");
  });

  test("`get` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "get", "--manager-id", "", "--connector-id", "c-1"]),
    ).rejects.toThrow("required option '--manager-id <manager-id>' not specified");
  });

  test("`get` errors when --connector-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "get", "--manager-id", "m-1", "--connector-id", ""]),
    ).rejects.toThrow("required option '--connector-id <connector-id>' not specified");
  });

  test("`list` errors when --manager-id is omitted", async () => {
    await expect(run(["payment", "connector", "list", "--manager-id", ""])).rejects.toThrow(
      "required option '--manager-id <manager-id>' not specified",
    );
  });

  test("`update` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "update", "--manager-id", "", "--connector-id", "c-1"]),
    ).rejects.toThrow("required option '--manager-id <manager-id>' not specified");
  });

  test("`update` errors when --connector-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "update", "--manager-id", "m-1", "--connector-id", ""]),
    ).rejects.toThrow("required option '--connector-id <connector-id>' not specified");
  });

  test("`update` does not offer --type", async () => {
    await expect(
      run([
        "payment",
        "connector",
        "update",
        "--manager-id",
        "m-1",
        "--connector-id",
        "c-1",
        "--type",
        "StripePrivy",
      ]),
    ).rejects.toThrow(/unknown option '--type'/);
  });

  test("`delete` errors when --manager-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "delete", "--manager-id", "", "--connector-id", "c-1"]),
    ).rejects.toThrow("required option '--manager-id <manager-id>' not specified");
  });

  test("`delete` errors when --connector-id is omitted", async () => {
    await expect(
      run(["payment", "connector", "delete", "--manager-id", "m-1", "--connector-id", ""]),
    ).rejects.toThrow("required option '--connector-id <connector-id>' not specified");
  });
});

// ─── stderr hints against a faked control plane ──────────────────────────────
//
// The consent-window states are not reachable on demand in a recording (a
// Quick Create connector expires ten minutes after creation), so the control
// plane is faked at .send() while the real PaymentClient and handlers run.

const AUTHORIZATION_URL = "https://login.coinbase.com/oauth2/auth?client_id=agentcore&state=abc";

function connectorDetail(
  status: GetPaymentConnectorResponse["status"],
): GetPaymentConnectorResponse {
  return {
    paymentConnectorId: "quick-abc123",
    name: QUICK_NAME,
    type: "CoinbaseCDP",
    credentialProviderConfigurations: [],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    lastUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status,
  };
}

function coreReturningConnector(detail: GetPaymentConnectorResponse): CoreClient {
  return createFakedControlCore(async (command) => {
    if (command instanceof GetPaymentConnectorCommand) return detail;
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  });
}

function coreCreatingPendingConnector(): CoreClient {
  const created: CreatePaymentConnectorResponse = {
    ...connectorDetail("PENDING_AUTHENTICATION"),
    paymentManagerId: MANAGER_ID,
    authorizationUrl: AUTHORIZATION_URL,
  };
  return createFakedControlCore(async (command) => {
    if (command instanceof CreatePaymentConnectorCommand) return created;
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  });
}

describe("payment connector hints", () => {
  const getArgs = [
    "payment",
    "connector",
    "get",
    "--manager-id",
    MANAGER_ID,
    "--connector-id",
    "quick-abc123",
  ];

  test("`get` prints a re-create hint on stderr for AUTHENTICATION_EXPIRED", async () => {
    const { stdout, stderr } = await runCapturing(
      getArgs,
      coreReturningConnector(connectorDetail("AUTHENTICATION_EXPIRED")),
    );
    expect(JSON.parse(stdout).status).toBe("AUTHENTICATION_EXPIRED");
    expect(stderr).toContain("cannot be renewed");
    expect(stderr).toContain("create it again with --quick-create");
  });

  test("`get` prints the same hint for AUTHENTICATION_FAILED", async () => {
    const { stdout, stderr } = await runCapturing(
      getArgs,
      coreReturningConnector(connectorDetail("AUTHENTICATION_FAILED")),
    );
    expect(JSON.parse(stdout).status).toBe("AUTHENTICATION_FAILED");
    expect(stderr).toContain("create it again with --quick-create");
  });

  test("`get` prints no hint for a READY connector", async () => {
    const { stderr } = await runCapturing(
      getArgs,
      coreReturningConnector(connectorDetail("READY")),
    );
    expect(stderr).toBe("");
  });

  test("`get --json` suppresses the hint", async () => {
    const { stdout, stderr } = await runCapturing(
      [...getArgs, "--json"],
      coreReturningConnector(connectorDetail("AUTHENTICATION_EXPIRED")),
    );
    expect(JSON.parse(stdout).status).toBe("AUTHENTICATION_EXPIRED");
    expect(stderr).toBe("");
  });

  const createArgs = [
    "payment",
    "connector",
    "create",
    "--manager-id",
    MANAGER_ID,
    "--name",
    QUICK_NAME,
    "--quick-create",
  ];

  test("`create --quick-create` prints the authorization hint on stderr", async () => {
    const { stdout, stderr } = await runCapturing(createArgs, coreCreatingPendingConnector());
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("PENDING_AUTHENTICATION");
    expect(parsed.authorizationUrl).toBe(AUTHORIZATION_URL);
    expect(stderr).toContain(AUTHORIZATION_URL);
    expect(stderr).toContain("10 minutes");
    expect(stderr).toContain(
      `agentcore payment connector get --manager-id ${MANAGER_ID} --connector-id quick-abc123`,
    );
  });

  test.each([
    {
      label: "explicit region",
      regionArgs: ["--region", "eu-west-1"],
      environmentRegion: "us-east-1",
      endpointUrl: undefined,
    },
    {
      label: "resolved environment region",
      regionArgs: [],
      environmentRegion: "eu-west-1",
      endpointUrl: undefined,
    },
    {
      label: "endpoint containing URL punctuation, spaces, and a quote",
      regionArgs: ["--region", "eu-west-1"],
      environmentRegion: "us-east-1",
      endpointUrl: "https://payments.example.test/control path?mode=quick&label=O'Reilly#consent",
    },
  ])(
    "`create --quick-create` follow-up preserves $label",
    async ({ regionArgs, environmentRegion, endpointUrl }) => {
      const savedRegion = process.env.AWS_REGION;
      const configs: ClientConfig[] = [];
      const getRequests: GetPaymentConnectorCommand["input"][] = [];
      const factories = fixtureFactories(FIXTURES);
      const coreOptions = {
        ...factories,
        createControlClient: (config: ClientConfig) => {
          configs.push(config);
          return {
            send: async (command: unknown) => {
              if (command instanceof CreatePaymentConnectorCommand) {
                return parse(JSON.stringify(quickCreateFixture));
              }
              if (command instanceof GetPaymentConnectorCommand) {
                getRequests.push(command.input);
                return parse(
                  JSON.stringify({
                    ...quickCreateFixture,
                    status: "READY",
                    lastUpdatedAt: quickCreateFixture.createdAt,
                  }),
                );
              }
              throw new Error("unexpected command in Quick Create hint test");
            },
          } as unknown as BedrockAgentCoreControlClient;
        },
        logger: createSilentLogger(),
      };
      try {
        process.env.AWS_REGION = environmentRegion;
        const created = createRoot(new CoreClient(coreOptions));
        await created.root.route([
          "node",
          "agentcore",
          ...createArgs,
          ...regionArgs,
          ...(endpointUrl === undefined ? [] : ["--endpoint-url", endpointUrl]),
        ]);
        expect(configs).toEqual([{ region: "eu-west-1", endpoint: endpointUrl }]);

        const command = created.io.stderr().match(/`(agentcore payment connector get [^`]+)`/)?.[1];
        expect(command).toBeDefined();
        // Parse the displayed command with a shell without invoking the installed CLI.
        const argv = execFileSync("sh", ["-c", `set -- ${command}\nprintf '%s\\0' "$@"`], {
          encoding: "utf8",
        })
          .split("\0")
          .slice(0, -1);

        process.env.AWS_REGION = "us-east-1";
        const followUp = createRoot(new CoreClient(coreOptions));
        await followUp.root.route(["node", ...argv]);
        expect(getRequests).toEqual([
          {
            paymentManagerId: MANAGER_ID,
            paymentConnectorId: quickCreateFixture.paymentConnectorId,
          },
        ]);
        expect(configs).toEqual([
          { region: "eu-west-1", endpoint: endpointUrl },
          { region: "eu-west-1", endpoint: endpointUrl },
        ]);
        expect(JSON.parse(followUp.io.stdout()).status).toBe("READY");
        expect(followUp.io.stderr()).toBe("");
        if (endpointUrl === undefined) expect(command).not.toContain("--endpoint-url");
      } finally {
        if (savedRegion === undefined) delete process.env.AWS_REGION;
        else process.env.AWS_REGION = savedRegion;
      }
    },
  );

  test.each([
    undefined,
    "https://payments.example.test/control path?mode=quick&label=O'Reilly#consent",
  ])("`create --quick-create --json` suppresses the hint with endpoint %j", async (endpointUrl) => {
    const { stdout, stderr } = await runCapturing(
      [
        ...createArgs,
        ...(endpointUrl === undefined ? [] : ["--endpoint-url", endpointUrl]),
        "--json",
      ],
      coreCreatingPendingConnector(),
    );
    expect(JSON.parse(stdout).authorizationUrl).toBe(AUTHORIZATION_URL);
    expect(stderr).toBe("");
  });
});

// ─── manual flow (create → get → list → update → delete) ─────────────────────
//
// Drives the lifecycle of a real connector backed by an existing CoinbaseCDP
// payment credential provider, in order, through route(). In record mode it hits
// the live control plane and persists every exchange; replays are offline and
// instant. Later tests consume the id parsed from earlier output.

const state: { connectorId?: string; quickConnectorId?: string } = {};

describe("payment connector manual flow", () => {
  test(
    "`create` infers the type from the named credential provider",
    async () => {
      const out = await run([
        "payment",
        "connector",
        "create",
        "--manager-id",
        MANAGER_ID,
        "--name",
        MANUAL_NAME,
        "--description",
        "Created by the agentcore CLI end-to-end test",
        "--credential-provider",
        CREDENTIAL_PROVIDER,
      ]);
      matchGolden(FIXTURES, "connector-create.golden.json", out);

      const parsed = JSON.parse(out);
      expect(parsed.name).toBe(MANUAL_NAME);
      // No --type was passed: the vendor of the named provider decided it.
      expect(parsed.type).toBe("CoinbaseCDP");
      expect(parsed.paymentConnectorId).toBeDefined();
      state.connectorId = parsed.paymentConnectorId;

      await pollUntil(
        [
          "payment",
          "connector",
          "get",
          "--manager-id",
          MANAGER_ID,
          "--connector-id",
          state.connectorId!,
        ],
        (o) => o.status === "READY",
      );
    },
    FLOW_TIMEOUT,
  );

  test("`list` includes the connector", async () => {
    const out = await run(["payment", "connector", "list", "--manager-id", MANAGER_ID]);
    matchGolden(FIXTURES, "connector-list.golden.json", out);

    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.paymentConnectors)).toBe(true);
    expect(
      parsed.paymentConnectors.map((c: { paymentConnectorId: string }) => c.paymentConnectorId),
    ).toContain(state.connectorId);
  });

  test(
    "`update` changes the description",
    async () => {
      const out = await run([
        "payment",
        "connector",
        "update",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        state.connectorId!,
        "--description",
        "Updated by the agentcore CLI end-to-end test",
      ]);
      matchGolden(FIXTURES, "connector-update.golden.json", out);
      expect(JSON.parse(out).paymentConnectorId).toBe(state.connectorId);

      await pollUntil(
        [
          "payment",
          "connector",
          "get",
          "--manager-id",
          MANAGER_ID,
          "--connector-id",
          state.connectorId!,
        ],
        (o) => o.status === "READY" && /Updated by/.test(o.description ?? ""),
      );
    },
    FLOW_TIMEOUT,
  );

  // Sits after `update` on purpose: every `get` of this connector shares one
  // fixture, which holds the last recorded (post-update) state.
  test("`get` prints the connector detail as JSON", async () => {
    const { stdout, stderr } = await runCapturing([
      "payment",
      "connector",
      "get",
      "--manager-id",
      MANAGER_ID,
      "--connector-id",
      state.connectorId!,
    ]);
    matchGolden(FIXTURES, "connector-get.golden.json", stdout);

    const parsed = JSON.parse(stdout);
    expect(parsed.paymentConnectorId).toBe(state.connectorId);
    expect(parsed.status).toBe("READY");
    expect(parsed.description).toBe("Updated by the agentcore CLI end-to-end test");
    expect(parsed.credentialProviderConfigurations[0].coinbaseCDP.credentialProviderArn).toContain(
      CREDENTIAL_PROVIDER,
    );
    expect(stderr).toBe("");
  });

  test(
    "`delete` deletes the connector",
    async () => {
      const out = await run([
        "payment",
        "connector",
        "delete",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        state.connectorId!,
      ]);
      matchGolden(FIXTURES, "connector-delete.golden.json", out);
      expect(JSON.parse(out).status).toBe("DELETING");

      await pollUntilGone([
        "payment",
        "connector",
        "get",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        state.connectorId!,
      ]);
    },
    FLOW_TIMEOUT,
  );
});

// ─── Quick Create flow (create → delete) ─────────────────────────────────────
//
// Quick Create asks Coinbase to provision the credentials after OAuth consent.
// The consent is never completed here: the test only checks that the CLI hands
// back the authorization URL and cleans the pending connector up again.

describe("payment connector quick create flow", () => {
  test(
    "`create --quick-create` returns a pending connector with an authorization URL",
    async () => {
      const { stdout, stderr } = await runCapturing([
        "payment",
        "connector",
        "create",
        "--manager-id",
        MANAGER_ID,
        "--name",
        QUICK_NAME,
        "--quick-create",
      ]);
      matchGolden(FIXTURES, "connector-quick-create.golden.json", stdout);

      const parsed = JSON.parse(stdout);
      expect(parsed.name).toBe(QUICK_NAME);
      expect(parsed.type).toBe("CoinbaseCDP");
      expect(parsed.status).toBe("PENDING_AUTHENTICATION");
      expect(parsed.authorizationUrl).toMatch(/^https:\/\//);
      expect(parsed.paymentConnectorId).toBeDefined();
      state.quickConnectorId = parsed.paymentConnectorId;

      expect(stderr).toContain(parsed.authorizationUrl);
      expect(stderr).toContain(
        `agentcore payment connector get --manager-id ${MANAGER_ID} --connector-id ${state.quickConnectorId}`,
      );
    },
    FLOW_TIMEOUT,
  );

  test(
    "`delete` removes the pending connector",
    async () => {
      const out = await run([
        "payment",
        "connector",
        "delete",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        state.quickConnectorId!,
      ]);
      matchGolden(FIXTURES, "connector-quick-delete.golden.json", out);
      expect(JSON.parse(out).status).toBe("DELETING");

      await pollUntilGone([
        "payment",
        "connector",
        "get",
        "--manager-id",
        MANAGER_ID,
        "--connector-id",
        state.quickConnectorId!,
      ]);
    },
    FLOW_TIMEOUT,
  );
});
