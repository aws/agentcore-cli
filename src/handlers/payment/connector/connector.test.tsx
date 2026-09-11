import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  parse,
  TestGlobalConfigAccessor,
  testIO,
  waitFor,
} from "../../../testing";
import quickCreateFixture from "../__fixtures__/connector/CreatePaymentConnectorCommand.3a23138a2103205b.json";
import connectorGetFixture from "../__fixtures__/connector/GetPaymentConnectorCommand.9f8dfd59b8af870.json";

const FIXTURES = join(import.meta.dir, "..", "__fixtures__", "connector");
const REGION = "us-west-2";
const MANAGER_ID = "mypaymentmanageraidandal-gx3nxzaira";
const CREDENTIAL_PROVIDER = "MyPaymentManagerAidandal-MyCdpConnectorAidandal-cdp";
const MANUAL_NAME = "AgentCoreCliConnectorE2E";
const QUICK_NAME = "AgentCoreCliQuickE2E";
const scoped = ["--manager-id", MANAGER_ID];
const quickArgs = ["create", ...scoped, "--name", QUICK_NAME, "--quick-create"];

function createFixtureCore(fixtures = FIXTURES): CoreClient {
  return new CoreClient({ ...fixtureFactories(fixtures), logger: createSilentLogger() });
}

async function run(
  args: string[],
  { core = createFixtureCore(), regionArgs = ["--region", REGION] } = {},
) {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "payment", "connector", ...args, ...regionArgs]);
  return io;
}

async function waitForDeletion(args: string[]) {
  await waitFor(
    async () => {
      try {
        await run(["get", ...args], { core: createFixtureCore(join(FIXTURES, "after-delete")) });
        return false;
      } catch (error) {
        expect(error).toMatchObject({ name: "ResourceNotFoundException" });
        return true;
      }
    },
    isRecording() ? 300_000 : 0,
    5_000,
  );
}

describe("payment connector write inputs", () => {
  test.each([
    { args: [] },
    { args: ["--quick-create", "--credential-provider", CREDENTIAL_PROVIDER] },
  ])("requires exactly one credential source: $args", async ({ args }) => {
    await expect(run(["create", ...scoped, "--name", MANUAL_NAME, ...args])).rejects.toThrow(
      "specify exactly one of '--quick-create' or '--credential-provider'",
    );
  });

  test.each(["create", "update"] as const)(
    "%s rejects an empty credential reference before Core",
    async (command) => {
      const core = createFixtureCore();
      const call = spyOn(
        core.payment,
        command === "create" ? "createPaymentConnector" : "updatePaymentConnector",
      );
      await expect(
        run(
          [
            command,
            ...scoped,
            ...(command === "create" ? ["--name", MANUAL_NAME] : ["--connector-id", "c-1"]),
            "--credential-provider",
            "",
          ],
          { core },
        ),
      ).rejects.toThrow("Invalid value for option '--credential-provider'");
      expect(call).not.toHaveBeenCalled();
    },
  );

  test("update forwards a replacement credential reference, empty description, and client token", async () => {
    const factories = fixtureFactories(FIXTURES);
    const control = factories.createControlClient({ region: REGION });
    spyOn(control, "send")
      .mockResolvedValueOnce(parse(JSON.stringify(connectorGetFixture)))
      .mockImplementationOnce(async () => ({}));
    const core = new CoreClient({
      ...factories,
      createControlClient: () => control,
      logger: createSilentLogger(),
    });
    const update = spyOn(core.payment, "updatePaymentConnector");
    const providerArn =
      connectorGetFixture.credentialProviderConfigurations[0]!.coinbaseCDP.credentialProviderArn;

    await run(
      [
        "update",
        ...scoped,
        "--connector-id",
        "c-1",
        "--credential-provider",
        providerArn,
        "--description",
        "",
        "--client-token",
        "token-1",
      ],
      { core },
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      {
        managerId: MANAGER_ID,
        connectorId: "c-1",
        credentialProvider: providerArn,
        description: "",
        clientToken: "token-1",
      },
      { region: REGION },
    );
  });

  test("update cannot change the connector type", async () => {
    await expect(
      run(["update", ...scoped, "--connector-id", "c-1", "--type", "StripePrivy"]),
    ).rejects.toThrow("unknown option '--type'");
  });
});

describe("payment connector Quick Create hints", () => {
  test.each([
    {
      label: "explicit region over the environment",
      regionArgs: ["--region", "eu-west-1"],
      environment: "us-east-1",
      endpoint: undefined,
    },
    {
      label: "environment region and shell-quoted endpoint",
      regionArgs: [
        "--endpoint-url",
        "https://payments.example.test/control path?mode=quick&label=O'Reilly#consent",
      ],
      environment: "eu-west-1",
      endpoint: "https://payments.example.test/control path?mode=quick&label=O'Reilly#consent",
    },
  ])("hint includes the resolved $label", async ({ regionArgs, environment, endpoint }) => {
    const savedRegion = process.env.AWS_REGION;
    const core = createFixtureCore();
    const create = spyOn(core.payment, "createPaymentConnector").mockResolvedValue(
      parse(JSON.stringify(quickCreateFixture)),
    );

    try {
      process.env.AWS_REGION = environment;
      const created = await run(quickArgs, {
        core,
        regionArgs: [...regionArgs],
      });
      const command = created.stderr().match(/`(agentcore payment connector get [^`]+)`/)?.[1];
      const endpointFlag =
        endpoint === undefined
          ? ""
          : " --endpoint-url 'https://payments.example.test/control path?mode=quick&label=O'\\''Reilly#consent'";
      expect(command).toBe(
        `agentcore payment connector get --manager-id ${MANAGER_ID} --connector-id ${quickCreateFixture.paymentConnectorId} --region eu-west-1${endpointFlag}`,
      );
      expect(create.mock.calls[0]?.[1]).toEqual({
        region: "eu-west-1",
        ...(endpoint === undefined ? {} : { endpointUrl: endpoint }),
      });
    } finally {
      if (savedRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = savedRegion;
    }
  });

  test("--json keeps the authorization URL in stdout without a stderr hint", async () => {
    const core = createFixtureCore();
    spyOn(core.payment, "createPaymentConnector").mockResolvedValue(
      parse(JSON.stringify(quickCreateFixture)),
    );
    const io = await run([...quickArgs, "--json"], { core });
    expect(JSON.parse(io.stdout()).authorizationUrl).toMatch(/^https:\/\//);
    expect(io.stderr()).toBe("");
  });
});

test("payment connector lifecycle replays named-provider creation, update, and deletion through root/Core", async () => {
  const created = await run([
    "create",
    ...scoped,
    "--name",
    MANUAL_NAME,
    "--description",
    "Created by the agentcore CLI end-to-end test",
    "--credential-provider",
    CREDENTIAL_PROVIDER,
  ]);
  matchGolden(FIXTURES, "connector-create.golden.json", created.stdout());
  const connector = JSON.parse(created.stdout());
  expect(connector.type).toBe("CoinbaseCDP");
  const connectorArgs = [...scoped, "--connector-id", connector.paymentConnectorId];
  await waitFor(
    async () => JSON.parse((await run(["get", ...connectorArgs])).stdout()).status === "READY",
    isRecording() ? 300_000 : 0,
    5_000,
  );

  const description = "Updated by the agentcore CLI end-to-end test";
  const updated = await run(["update", ...connectorArgs, "--description", description]);
  matchGolden(FIXTURES, "connector-update.golden.json", updated.stdout());
  await waitFor(
    async () => {
      const result = JSON.parse((await run(["get", ...connectorArgs])).stdout());
      return result.status === "READY" && result.description === description;
    },
    isRecording() ? 300_000 : 0,
    5_000,
  );
  const detail = await run(["get", ...connectorArgs]);
  matchGolden(FIXTURES, "connector-get.golden.json", detail.stdout());
  expect(JSON.parse(detail.stdout())).toMatchObject({
    paymentConnectorId: connector.paymentConnectorId,
    status: "READY",
    description,
  });

  const deleted = await run(["delete", ...connectorArgs]);
  matchGolden(FIXTURES, "connector-delete.golden.json", deleted.stdout());
  expect(JSON.parse(deleted.stdout()).status).toBe("DELETING");
  await waitForDeletion(connectorArgs);
}, 1_800_000);

test("payment connector Quick Create lifecycle returns consent instructions and deletes the pending connector", async () => {
  const created = await run(quickArgs);
  matchGolden(FIXTURES, "connector-quick-create.golden.json", created.stdout());
  const connector = JSON.parse(created.stdout());
  expect(connector.status).toBe("PENDING_AUTHENTICATION");
  expect(connector.authorizationUrl).toMatch(/^https:\/\//);
  expect(created.stderr()).toContain(connector.authorizationUrl);
  expect(created.stderr()).toContain("10 minutes");
  expect(created.stderr()).toContain(
    `agentcore payment connector get --manager-id ${MANAGER_ID} --connector-id ${connector.paymentConnectorId}`,
  );

  const connectorArgs = [...scoped, "--connector-id", connector.paymentConnectorId];
  const deleted = await run(["delete", ...connectorArgs]);
  matchGolden(FIXTURES, "connector-quick-delete.golden.json", deleted.stdout());
  expect(JSON.parse(deleted.stdout()).status).toBe("DELETING");
  await waitForDeletion(connectorArgs);
}, 600_000);
