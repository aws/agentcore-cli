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
  pruneTelemetrySecrets,
  removeTelemetrySecrets,
  secretsManagerCalls,
  telemetrySecretFieldsOfOtherTargets,
  telemetrySecretRecords,
  telemetrySecretsOfOtherTargets,
  telemetrySecretTags,
  type TelemetrySecretCalls,
} from "./telemetrySecrets";

const NAME = "agentcore/demo/agent/box";
/** The name of the secret of runtime `runtime` of project demo. */
const nameOf = (runtime: string) => `agentcore/demo/${runtime}/box`;
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
/** The fields of {@link SECRET}. */
const FIELDS = ["telemetry.langsmith", "telemetry.langfuse"];
/** What deploy returns for {@link SECRET} at `secretArn`, with the `stale` fields it keeps. */
const storedOf = (secretArn: string, stale: string[] = []) => ({
  secretArn,
  fields: FIELDS,
  stale,
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

/** A secret in the stub. Its tags are the tags deploy gives it, unless `tags` gives others. */
type Stored = { arn: string; deleted: boolean; value?: string; tags?: Record<string, string> };

/** Stub calls that answer from `secrets`, by name or ARN, and record every call but describe. */
function stubCalls(
  secrets: Record<string, Stored> = {},
  fail: Partial<Record<"create" | "put" | "delete", Error>> = {},
) {
  const calls: string[] = [];
  let created = 0;
  const find = (id: string) =>
    Object.entries(secrets).find(([name, { arn }]) => name === id || arn === id);
  const stub: TelemetrySecretCalls = {
    describe: async (id) => {
      const [name, found] = find(id) ?? [];
      if (name === undefined || found === undefined) return undefined;
      const tags = found.tags ?? telemetrySecretTags("demo", name.split("/")[2] ?? "");
      return { arn: found.arn, deleted: found.deleted, tags };
    },
    read: async (arn) => {
      calls.push(`read ${arn}`);
      return find(arn)?.[1].value;
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
  const warnings: string[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { steps, warnings, value: next.value };
    if (next.value.type === "step") steps.push(next.value.message);
    if (next.value.type === "warning") warnings.push(next.value.message);
  }
}

describe("secretsManagerCalls", () => {
  const client = (answer: (command: unknown) => unknown) => {
    const send = mock(async (command: unknown) => answer(command));
    return { send, calls: secretsManagerCalls({ send } as unknown as SecretsManagerClient) };
  };

  test("describes a secret by its name, and reads a scheduled deletion and the tags", async () => {
    const { send, calls } = client((command) =>
      command instanceof DescribeSecretCommand
        ? { ARN, DeletedDate: new Date(0), Tags: [{ Key: "team", Value: "a" }, { Value: "b" }] }
        : undefined,
    );

    expect(await calls.describe(NAME)).toEqual({ arn: ARN, deleted: true, tags: { team: "a" } });
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

    const tags = telemetrySecretTags("demo", "agent");
    expect(await calls.create({ name: NAME, value: OBJECT, description: "d", tags })).toBe(ARN);
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
      {
        Name: NAME,
        SecretString: OBJECT,
        Description: "d",
        Tags: [
          { Key: "agentcore:created-by", Value: "agentcore-cli" },
          { Key: "agentcore:project-name", Value: "demo" },
          { Key: "agentcore:runtime-name", Value: "agent" },
        ],
      },
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
    expect(value).toEqual({ [NAME]: storedOf(`${ARN}1`) });
    expect(steps).toEqual([`preparing secret '${NAME}' for the box telemetry of 'agent'`]);
  });

  test("tags the secret it creates with the project and the runtime", async () => {
    const { stub } = stubCalls();
    const created: unknown[] = [];
    const create = stub.create;
    stub.create = async (input) => {
      created.push(input.tags);
      return create(input);
    };

    await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], KEYS));

    expect(created).toEqual([
      {
        "agentcore:created-by": "agentcore-cli",
        "agentcore:project-name": "demo",
        "agentcore:runtime-name": "agent",
      },
    ]);
  });

  test.each([
    ["no tags", false, {}],
    ["scheduled for deletion, with no tags", true, {}],
    ["the tags of another runtime", false, telemetrySecretTags("demo", "other")],
    [
      "the tags of another tool",
      false,
      { ...telemetrySecretTags("demo", "agent"), "agentcore:created-by": "someone" },
    ],
  ])(
    "stops before any read or write for a secret of that name with %s, and names it",
    async (_label, deleted, tags) => {
      const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted, tags } });
      const root = await project();

      // With no key, deploy would read the secret; with each key, it would write it.
      for (const env of [{}, KEYS]) {
        const error = await drain(provisionTelemetrySecrets(stub, root, [SECRET], env)).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(ProjectStateError);
        expect((error as Error).message).toBe(
          `Deploy stopped before it wrote a secret. AWS Secrets Manager has secret '${NAME}', ` +
            "but that secret does not have the tags that deploy gives to the secret of runtime " +
            "'agent' (agentcore:created-by=agentcore-cli, agentcore:project-name=demo, " +
            "agentcore:runtime-name=agent). Deploy does not write or delete a secret that it did " +
            "not create. If no project uses that secret, delete it with no recovery window, or " +
            "change the name of the runtime. Then deploy again.",
        );
      }
      expect(calls).toEqual([]);
    },
  );

  test("reads a secret that exists, and puts every key when its object is not equal", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false } });

    const { value } = await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], KEYS));

    expect(calls).toEqual([`read ${ARN}`, `put ${ARN} ${OBJECT}`]);
    expect(value).toEqual({ [NAME]: storedOf(ARN) });
  });

  test("keeps a secret whose object is equal, when deploy has each key", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: OBJECT } });
    const root = await project(`${LANGSMITH}=${KEYS[LANGSMITH]}\n${LANGFUSE}=${KEYS[LANGFUSE]}\n`);

    for (const env of [{}, KEYS]) {
      const { value } = await drain(provisionTelemetrySecrets(stub, root, [SECRET], env));

      expect(value).toEqual({ [NAME]: storedOf(ARN) });
    }
    expect(calls).toEqual([`read ${ARN}`, `read ${ARN}`]);
  });

  test("keeps a secret that holds each field when deploy has no key", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: OBJECT } });

    const { value } = await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], {}));

    expect(calls).toEqual([`read ${ARN}`]);
    expect(value).toEqual({ [NAME]: storedOf(ARN) });
  });

  test("keeps the value of a field whose key deploy lacks, and the field of a target that went", async () => {
    const held = JSON.stringify({
      "telemetry.langsmith": "dummy-old",
      "telemetry.langfuse": KEYS[LANGFUSE],
      "telemetry.gone": "dummy-gone",
    });
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: held } });

    const { value } = await drain(
      provisionTelemetrySecrets(stub, await project(), [SECRET], { [LANGSMITH]: KEYS[LANGSMITH] }),
    );

    const union = JSON.stringify({ ...JSON.parse(OBJECT), "telemetry.gone": "dummy-gone" });
    expect(calls).toEqual([`read ${ARN}`, `put ${ARN} ${union}`]);
    expect(value).toEqual({ [NAME]: storedOf(ARN, ["telemetry.gone"]) });
  });

  test("keeps a secret that holds the field of a target that went, and each key deploy has", async () => {
    const held = JSON.stringify({ ...JSON.parse(OBJECT), "telemetry.gone": "dummy-gone" });
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: held } });

    const { value } = await drain(provisionTelemetrySecrets(stub, await project(), [SECRET], KEYS));

    expect(calls).toEqual([`read ${ARN}`]);
    expect(value).toEqual({ [NAME]: storedOf(ARN, ["telemetry.gone"]) });
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
          "or in the environment you deploy from. Build copies the value of LANGSMITH_KEY into " +
          "that file when the shell that runs build, or that file, has a value for it.",
      );
      expect(calls).toEqual([]);
    },
  );

  test("removes the secrets it created when a later write fails, and keeps the error", async () => {
    const existing: BoxTelemetrySecret = { ...SECRET, runtime: "other", name: nameOf("other") };
    const failure = new Error("put refused");
    const { stub, calls } = stubCalls(
      { [nameOf("other")]: { arn: "arn:existing", deleted: false } },
      { put: failure },
    );

    const error = await drain(
      provisionTelemetrySecrets(stub, await project(), [SECRET, existing], KEYS),
    ).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(calls).toEqual([
      "read arn:existing",
      `create ${NAME} ${OBJECT}`,
      `put arn:existing ${OBJECT}`,
      `delete ${ARN}1`,
    ]);
  });

  test("warns when it cannot remove a secret it created, and keeps the error", async () => {
    const existing: BoxTelemetrySecret = { ...SECRET, runtime: "other", name: nameOf("other") };
    const failure = new Error("put refused");
    const { stub } = stubCalls(
      { [nameOf("other")]: { arn: "arn:existing", deleted: false } },
      { put: failure, delete: new Error("AccessDenied") },
    );
    const warnings: string[] = [];

    const error = await (async () => {
      try {
        for await (const event of provisionTelemetrySecrets(
          stub,
          await project(),
          [SECRET, existing],
          KEYS,
        )) {
          if (event.type === "warning") warnings.push(event.message);
        }
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBe(failure);
    expect(warnings).toEqual([
      `Deploy did not remove secret ${ARN}1, which this deploy created: AccessDenied. The ` +
        "secret stays in AWS Secrets Manager, and AWS bills you for it. It is not recorded, thus " +
        "the next deploy of this target uses it again.",
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
      [nameOf("a")]: { arn: "arn:a", deleted: false },
      [nameOf("shared")]: { arn: "arn:shared", deleted: false },
      [nameOf("scheduled")]: { arn: "arn:scheduled", deleted: true },
    });

    const { value, steps } = await drain(
      removeTelemetrySecrets(
        stub,
        {
          [nameOf("a")]: { secretArn: "arn:a" },
          [nameOf("shared")]: { secretArn: "arn:shared" },
          [nameOf("scheduled")]: { secretArn: "arn:scheduled" },
          [nameOf("gone")]: { secretArn: "arn:gone" },
        },
        new Set(["arn:shared"]),
      ),
    );

    expect(calls).toEqual(["delete arn:a"]);
    expect(value).toEqual({});
    expect(steps).toEqual([
      `deleting secret '${nameOf("a")}'`,
      `keeping secret '${nameOf("shared")}': another deployment target records it`,
    ]);
  });

  test("warns about a secret it cannot delete, and returns it so its record stays", async () => {
    const { stub } = stubCalls(
      { [NAME]: { arn: ARN, deleted: false } },
      { delete: new Error("AccessDenied") },
    );

    const { value, steps, warnings } = await drain(
      removeTelemetrySecrets(stub, { [NAME]: { secretArn: ARN } }, new Set()),
    );

    expect(value).toEqual({ [NAME]: { secretArn: ARN } });
    expect(steps).toEqual([`deleting secret '${NAME}'`]);
    expect(warnings).toEqual([
      `Deploy did not delete secret '${NAME}' (${ARN}): AccessDenied. The secret stays in AWS ` +
        "Secrets Manager, and AWS bills you for it. Deploy keeps its record of the secret, and " +
        "the next deploy of this target tries to delete it again, also when the stack is gone.",
    ]);
  });

  test("does not delete a secret without the tags that deploy gives, warns, and drops its record", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, tags: {} } });

    const { value, steps, warnings } = await drain(
      removeTelemetrySecrets(stub, { [NAME]: { secretArn: ARN } }, new Set()),
    );

    expect(calls).toEqual([]);
    expect(value).toEqual({});
    expect(steps).toEqual([]);
    expect(warnings).toEqual([
      `Deploy did not delete AWS Secrets Manager secret '${NAME}' (${ARN}), because that ` +
        "secret does not have the tags that deploy gives to the secrets that it creates. Deploy " +
        "removes its record of that secret. If no project uses it, delete it.",
    ]);
  });
});

describe("pruneTelemetrySecrets", () => {
  const HELD = JSON.stringify({
    ...JSON.parse(OBJECT),
    "telemetry.gone": "dummy-gone",
    "telemetry.old": "dummy-old",
  });
  const STALE = ["telemetry.gone", "telemetry.old"];

  test("removes each stale field that no other deployment target reads", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: HELD } });

    const { steps } = await drain(
      pruneTelemetrySecrets(stub, { [NAME]: storedOf(ARN, STALE) }, new Map()),
    );

    expect(calls).toEqual([`read ${ARN}`, `put ${ARN} ${OBJECT}`]);
    expect(steps).toEqual([
      `removing 'telemetry.gone', 'telemetry.old' from secret '${NAME}': no deployed runtime ` +
        "reads them",
    ]);
  });

  test("keeps a stale field that the runtime of another deployment target reads", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: HELD } });
    const others = new Map([[ARN, new Set(["telemetry.langsmith", "telemetry.gone"])]]);

    const { steps } = await drain(
      pruneTelemetrySecrets(stub, { [NAME]: storedOf(ARN, STALE) }, others),
    );

    const left = JSON.stringify({ ...JSON.parse(OBJECT), "telemetry.gone": "dummy-gone" });
    expect(calls).toEqual([`read ${ARN}`, `put ${ARN} ${left}`]);
    expect(steps).toEqual([
      `keeping 'telemetry.gone' in secret '${NAME}': another deployment target reads it`,
      `removing 'telemetry.old' from secret '${NAME}': no deployed runtime reads it`,
    ]);
  });

  test("keeps each stale field when another deployment target records the secret with no fields", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: HELD } });

    const { steps } = await drain(
      pruneTelemetrySecrets(stub, { [NAME]: storedOf(ARN, STALE) }, new Map([[ARN, undefined]])),
    );

    expect(calls).toEqual([]);
    expect(steps).toEqual([
      `keeping 'telemetry.gone', 'telemetry.old' in secret '${NAME}': another deployment target ` +
        "reads them",
    ]);
  });

  test("does nothing for a secret with no stale field", async () => {
    const { stub, calls } = stubCalls({ [NAME]: { arn: ARN, deleted: false, value: HELD } });

    const { steps } = await drain(
      pruneTelemetrySecrets(stub, { [NAME]: storedOf(ARN) }, new Map()),
    );

    expect(calls).toEqual([]);
    expect(steps).toEqual([]);
  });

  test("warns when it cannot change the secret, and does not fail", async () => {
    const { stub } = stubCalls(
      { [NAME]: { arn: ARN, deleted: false, value: HELD } },
      { put: new Error("AccessDenied") },
    );

    const { warnings } = await drain(
      pruneTelemetrySecrets(stub, { [NAME]: storedOf(ARN, ["telemetry.gone"]) }, new Map()),
    );

    expect(warnings).toEqual([
      `Deploy did not remove 'telemetry.gone' from secret '${NAME}' (${ARN}): AccessDenied. The ` +
        "secret keeps it, and the next deploy of this target tries to remove it again.",
    ]);
  });
});

describe("the records of the secrets", () => {
  test("finds the recorded secrets that no runtime declares any more", () => {
    const recorded = { [NAME]: { secretArn: ARN }, old: { secretArn: "arn:old" } };

    expect(orphanedTelemetrySecrets(recorded, [SECRET])).toEqual({ old: { secretArn: "arn:old" } });
  });

  test("records the fields of each secret, with each field the runtime read before", () => {
    const stored = { [NAME]: storedOf(ARN, ["telemetry.gone"]), other: storedOf("arn:other") };

    expect(telemetrySecretRecords(stored)).toEqual({
      [NAME]: { secretArn: ARN, fields: FIELDS },
      other: { secretArn: "arn:other", fields: FIELDS },
    });
    expect(
      telemetrySecretRecords(stored, {
        [NAME]: { secretArn: ARN, fields: ["telemetry.gone", "telemetry.langsmith"] },
        other: { secretArn: "arn:other" },
      }),
    ).toEqual({
      [NAME]: { secretArn: ARN, fields: ["telemetry.gone", ...FIELDS] },
      other: { secretArn: "arn:other" },
    });
  });

  test("collects the fields that the runtime of every other deployment target reads", () => {
    const record = (secretArn: string, fields?: string[]) => ({
      resources: { boxTelemetrySecrets: { [NAME]: { secretArn, ...(fields && { fields }) } } },
    });
    const state = {
      targets: {
        default: record(ARN, ["telemetry.mine"]),
        staging: record(ARN, ["telemetry.langsmith"]),
        test: record(ARN, ["telemetry.gone"]),
        old: record("arn:old"),
        older: record("arn:old", ["telemetry.langsmith"]),
        empty: {},
      },
    };

    expect(telemetrySecretFieldsOfOtherTargets(state, "default")).toEqual(
      new Map([
        [ARN, new Set(["telemetry.langsmith", "telemetry.gone"])],
        ["arn:old", undefined],
      ]),
    );
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
