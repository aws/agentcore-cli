import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  RestoreSecretCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { ProjectStateError } from "../../../../errors/errors";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { BoxTelemetrySecret } from "../../boxTelemetrySecrets";
import {
  orphanedTelemetrySecrets,
  provisionTelemetrySecrets,
  removeTelemetrySecrets,
  secretsManagerCalls,
  telemetrySecretsOfOtherTargets,
  type TelemetrySecretCalls,
} from "./telemetrySecrets";

const NAME = "agentcore/demo/agent/box";
const ARN = `arn:aws:secretsmanager:us-west-2:111122223333:secret:${NAME}-AbCdEf`;
const LANGSMITH = "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH";
const LANGFUSE = "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGFUSE";
const SECRET: BoxTelemetrySecret = {
  runtime: "agent",
  name: NAME,
  fields: [
    {
      target: "langsmith",
      field: "telemetry.langsmith",
      variable: LANGSMITH,
      source: "LANGSMITH_KEY",
    },
    {
      target: "langfuse",
      field: "telemetry.langfuse",
      variable: LANGFUSE,
      source: "LANGFUSE_AUTH",
    },
  ],
};
/** Stand-in keys: no real secret goes into a test. */
const KEYS = { [LANGSMITH]: "dummy-langsmith", [LANGFUSE]: "dummy-public:dummy-secret" };
const OBJECT = JSON.stringify({
  "telemetry.langsmith": "dummy-langsmith",
  "telemetry.langfuse": "dummy-public:dummy-secret",
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A project whose `agentcore/.env.local` holds `envLocal`. */
async function project(envLocal?: string): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-telemetry-secrets-"));
  directories.push(rootPath);
  if (envLocal !== undefined) {
    await mkdir(join(rootPath, "agentcore"), { recursive: true });
    await writeFile(join(rootPath, "agentcore", ".env.local"), envLocal, { mode: 0o600 });
  }
  return { name: "demo", rootPath, spec: ProjectSpecSchema.parse({ name: "demo", version: 2 }) };
}

type Stored = { arn: string; deleted: boolean; value?: string };

/** Stub calls that answer from `secrets`, by name or ARN, and record every call but describe. */
function stubCalls(
  secrets: Record<string, Stored> = {},
  fail: Partial<Record<"create" | "put" | "delete", Error>> = {},
) {
  const calls: string[] = [];
  let created = 0;
  const find = (id: string) => secrets[id] ?? Object.values(secrets).find(({ arn }) => arn === id);
  const stub: TelemetrySecretCalls = {
    describe: async (id) => {
      const found = find(id);
      return found && { arn: found.arn, deleted: found.deleted };
    },
    read: async (arn) => {
      calls.push(`read ${arn}`);
      return find(arn)?.value;
    },
    create: async ({ name, value }) => {
      calls.push(`create ${name} ${value}`);
      if (fail.create) throw fail.create;
      created++;
      return `${ARN}${created}`;
    },
    put: async (arn, value) => {
      calls.push(`put ${arn} ${value}`);
      if (fail.put) throw fail.put;
    },
    restore: async (arn) => {
      calls.push(`restore ${arn}`);
    },
    delete: async (arn) => {
      calls.push(`delete ${arn}`);
      if (fail.delete) throw fail.delete;
    },
  };
  return { stub, calls };
}

async function drain<T>(generator: AsyncGenerator<ProjectEvent, T>) {
  const steps: string[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { steps, value: next.value };
    if (next.value.type === "step") steps.push(next.value.message);
  }
}

describe("secretsManagerCalls", () => {
  const client = (answer: (command: unknown) => unknown) => {
    const send = mock(async (command: unknown) => answer(command));
    return { send, calls: secretsManagerCalls({ send } as unknown as SecretsManagerClient) };
  };

  test("describes a secret by its name, and reads a scheduled deletion", async () => {
    const { send, calls } = client((command) =>
      command instanceof DescribeSecretCommand ? { ARN, DeletedDate: new Date(0) } : undefined,
    );

    expect(await calls.describe(NAME)).toEqual({ arn: ARN, deleted: true });
    expect((send.mock.calls[0]![0] as DescribeSecretCommand).input).toEqual({ SecretId: NAME });
  });

  test("describes no secret when Secrets Manager has none by that name", async () => {
    const { calls } = client(() => {
      throw new ResourceNotFoundException({ message: "not found", $metadata: {} });
    });

    expect(await calls.describe(NAME)).toBeUndefined();
  });

  test("sends each write, and deletes with a recovery window", async () => {
    const { send, calls } = client((command) =>
      command instanceof CreateSecretCommand
        ? { ARN }
        : command instanceof GetSecretValueCommand
          ? { SecretString: OBJECT }
          : {},
    );

    expect(await calls.create({ name: NAME, value: OBJECT, description: "d" })).toBe(ARN);
    expect(await calls.read(ARN)).toBe(OBJECT);
    await calls.put(ARN, OBJECT);
    await calls.restore(ARN);
    await calls.delete(ARN);

    const sent = send.mock.calls.map(([command]) => command);
    expect(sent.map((command) => (command as object).constructor)).toEqual([
      CreateSecretCommand,
      GetSecretValueCommand,
      PutSecretValueCommand,
      RestoreSecretCommand,
      DeleteSecretCommand,
    ]);
    expect(sent.map((command) => (command as { input: unknown }).input)).toEqual([
      { Name: NAME, SecretString: OBJECT, Description: "d" },
      { SecretId: ARN },
      { SecretId: ARN, SecretString: OBJECT },
      { SecretId: ARN },
      { SecretId: ARN, RecoveryWindowInDays: 7 },
    ]);
  });
});

describe("provisionTelemetrySecrets", () => {
  test("creates an absent secret as one JSON object, with a key from the environment over .env.local", async () => {
    const { stub, calls } = stubCalls();
    const root = await project(`${LANGSMITH}=dummy-from-file\n${LANGFUSE}=${KEYS[LANGFUSE]}\n`);

    const { value, steps } = await drain(
      provisionTelemetrySecrets(stub, root, [SECRET], { [LANGSMITH]: KEYS[LANGSMITH] }),
    );

    expect(calls).toEqual([`create ${NAME} ${OBJECT}`]);
    expect(value).toEqual({ [NAME]: { secretArn: `${ARN}1` } });
    expect(steps).toEqual([`preparing secret '${NAME}' for the box telemetry of 'agent'`]);
  });

  test("puts every key in a secret that exists, with no read", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false } });

    const { value } = await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], KEYS));

    expect(calls).toEqual([`put ${ARN} ${OBJECT}`]);
    expect(value).toEqual({ [NAME]: { secretArn: ARN } });
  });

  test("keeps a secret that holds each field when deploy has no key", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: OBJECT } });

    const { value } = await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], {}));

    expect(calls).toEqual([`read ${ARN}`]);
    expect(value).toEqual({ [NAME]: { secretArn: ARN } });
  });

  test("keeps the value of a field whose key deploy lacks, and drops the field of a target that went", async () => {
    const held = JSON.stringify({
      "telemetry.langsmith": "dummy-old",
      "telemetry.langfuse": KEYS[LANGFUSE],
      "telemetry.gone": "dummy-gone",
    });
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: held } });

    await drain(
      provisionTelemetrySecrets(stub, await project(), [SECRET], { [LANGSMITH]: KEYS[LANGSMITH] }),
    );

    expect(calls).toEqual([`read ${ARN}`, `put ${ARN} ${OBJECT}`]);
  });

  test("restores a secret that is scheduled for deletion, then puts the keys", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: true } });

    await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], KEYS));

    expect(calls).toEqual([`restore ${ARN}`, `put ${ARN} ${OBJECT}`]);
  });

  test("reads only the variables of the fields from the environment", async () => {
    const { stub, calls } = stubCalls();

    await drain(
      provisionTelemetrySecrets(stub, await project(), [SECRET], {
        ...KEYS,
        LANGSMITH_KEY: "dummy-local-value",
        AGENTCORE_CREDENTIAL_OTHER: "dummy-other",
      }),
    );

    expect(calls).toEqual([`create ${NAME} ${OBJECT}`]);
  });

  test.each([
    ["absent", {}],
    ["scheduled for deletion", { [NAME]: { arn: ARN, deleted: true } }],
  ])(
    "fails before any write when a %s secret lacks a key, and names its variable",
    async (_label, secrets) => {
      const other: BoxTelemetrySecret = { ...SECRET, runtime: "other", name: "other" };
      const { stub, calls } = stubCalls(secrets);
      const root = await project();

      const error = await drain(
        provisionTelemetrySecrets(stub, root, [other, SECRET], { [LANGFUSE]: KEYS[LANGFUSE] }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProjectStateError);
      expect((error as Error).message).toBe(
        "Runtime 'other' has no key for [telemetry.langsmith] to store in AWS Secrets Manager " +
          `secret 'other'. Set ${LANGSMITH} in ${join(root.rootPath, "agentcore", ".env.local")} ` +
          "or in the environment you deploy from. Build copies LANGSMITH_KEY there when it is set.",
      );
      expect(calls).toEqual([]);
    },
  );

  test("removes the secrets it created when a later write fails, and keeps the error", async () => {
    const existing: BoxTelemetrySecret = { ...SECRET, runtime: "other", name: "existing" };
    const failure = new Error("put refused");
    const { stub, calls } = stubCalls(
      { existing: { arn: "arn:existing", deleted: false } },
      { put: failure },
    );

    const error = await drain(
      provisionTelemetrySecrets(stub, await project(), [SECRET, existing], KEYS),
    ).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(calls).toEqual([
      `create ${NAME} ${OBJECT}`,
      `put arn:existing ${OBJECT}`,
      `delete ${ARN}1`,
    ]);
  });

  test("does nothing for no secret", async () => {
    const { stub, calls } = stubCalls();

    const { value } = await drain(provisionTelemetrySecrets(stub, await project(), [], {}));

    expect(value).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe("removeTelemetrySecrets", () => {
  test("deletes each secret, except one that another target records or that is gone", async () => {
    const { stub, calls } = stubCalls({
      a: { arn: "arn:a", deleted: false },
      shared: { arn: "arn:shared", deleted: false },
      scheduled: { arn: "arn:scheduled", deleted: true },
    });

    const { value, steps } = await drain(
      removeTelemetrySecrets(
        stub,
        {
          a: { secretArn: "arn:a" },
          shared: { secretArn: "arn:shared" },
          scheduled: { secretArn: "arn:scheduled" },
          gone: { secretArn: "arn:gone" },
        },
        new Set(["arn:shared"]),
      ),
    );

    expect(calls).toEqual(["delete arn:a"]);
    expect(value).toEqual({});
    expect(steps).toEqual([
      "deleting secret 'a'",
      "keeping secret 'shared': another deployment target records it",
    ]);
  });

  test("reports a secret it cannot delete, and returns it so its record stays", async () => {
    const { stub } = stubCalls(
      { a: { arn: "arn:a", deleted: false } },
      { delete: new Error("AccessDenied") },
    );

    const { value, steps } = await drain(
      removeTelemetrySecrets(stub, { a: { secretArn: "arn:a" } }, new Set()),
    );

    expect(value).toEqual({ a: { secretArn: "arn:a" } });
    expect(steps).toContain("Could not delete secret 'a' (arn:a): AccessDenied.");
  });
});

describe("the records of the secrets", () => {
  test("finds the recorded secrets that no runtime declares any more", () => {
    const recorded = { [NAME]: { secretArn: ARN }, old: { secretArn: "arn:old" } };

    expect(orphanedTelemetrySecrets(recorded, [SECRET])).toEqual({ old: { secretArn: "arn:old" } });
  });

  test("collects the secrets every other deployment target records", () => {
    const state = {
      targets: {
        default: { resources: { boxTelemetrySecrets: { [NAME]: { secretArn: ARN } } } },
        staging: { resources: { boxTelemetrySecrets: { [NAME]: { secretArn: "arn:staging" } } } },
        empty: {},
      },
    };

    expect(telemetrySecretsOfOtherTargets(state, "default")).toEqual(new Set(["arn:staging"]));
  });
});
