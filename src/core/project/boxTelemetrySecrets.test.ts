import { describe, expect, test } from "bun:test";
import type { ThirdPartyTelemetry } from "./boxNetwork";
import {
  boxTelemetrySecretEnvEntries,
  boxTelemetrySecretRef,
  boxTelemetrySecrets,
  boxTelemetrySecretsStatement,
} from "./boxTelemetrySecrets";

const LANGSMITH: ThirdPartyTelemetry = {
  name: "langsmith",
  kind: "langsmith",
  keys: [],
  secret: { variable: "LANGSMITH_KEY", keys: [] },
};
const LANGFUSE: ThirdPartyTelemetry = {
  name: "langfuse",
  kind: "langfuse",
  keys: [],
  secret: { variable: "LANGFUSE_AUTH", keys: [] },
};
const COLLECTOR: ThirdPartyTelemetry = {
  name: "collector",
  kind: "otlp",
  keys: [["destination", "https://collector.example.com"]],
};

describe("boxTelemetrySecrets", () => {
  test("names one secret for each runtime, with one field for each target with a key", () => {
    const networks = [
      { runtime: "agent", thirdPartyTelemetry: [LANGSMITH, COLLECTOR, LANGFUSE] },
      { runtime: "other", thirdPartyTelemetry: [{ ...LANGSMITH, name: "lang-smith" }] },
      { runtime: "open", thirdPartyTelemetry: [COLLECTOR] },
      { runtime: "quiet" },
    ];

    expect(boxTelemetrySecrets("demo", networks)).toEqual([
      {
        runtime: "agent",
        name: "agentcore/demo/agent/box",
        fields: [
          {
            target: "langsmith",
            field: "telemetry.langsmith",
            variable: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH",
            source: "LANGSMITH_KEY",
          },
          {
            target: "langfuse",
            field: "telemetry.langfuse",
            variable: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGFUSE",
            source: "LANGFUSE_AUTH",
          },
        ],
      },
      {
        runtime: "other",
        name: "agentcore/demo/other/box",
        fields: [
          {
            target: "lang-smith",
            field: "telemetry.lang-smith",
            variable: "AGENTCORE_CREDENTIAL_OTHER_TELEMETRY_LANG_SMITH",
            source: "LANGSMITH_KEY",
          },
        ],
      },
    ]);
  });

  test("gives one field to each of two targets of the same kind", () => {
    const staging = {
      ...LANGFUSE,
      name: "langfuse_staging",
      secret: { variable: "STG", keys: [] },
    };
    const prod = { ...LANGFUSE, name: "langfuse_prod", secret: { variable: "PRD", keys: [] } };

    expect(
      boxTelemetrySecrets("demo", [{ runtime: "agent", thirdPartyTelemetry: [staging, prod] }]),
    ).toEqual([
      {
        runtime: "agent",
        name: "agentcore/demo/agent/box",
        fields: [
          {
            target: "langfuse_staging",
            field: "telemetry.langfuse_staging",
            variable: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGFUSE_STAGING",
            source: "STG",
          },
          {
            target: "langfuse_prod",
            field: "telemetry.langfuse_prod",
            variable: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGFUSE_PROD",
            source: "PRD",
          },
        ],
      },
    ]);
  });

  test("refers to one field of the secret, in the scheme Box reads", () => {
    expect(boxTelemetrySecretRef("agentcore/demo/agent/box", "telemetry.langsmith")).toBe(
      "aws-secretsmanager://agentcore/demo/agent/box#telemetry.langsmith",
    );
  });
});

describe("boxTelemetrySecretsStatement", () => {
  test("lets the execution role read each runtime's secret by its name, and no other secret", () => {
    const secrets = boxTelemetrySecrets("demo", [
      { runtime: "agent", thirdPartyTelemetry: [LANGSMITH, LANGFUSE] },
    ]);

    expect(boxTelemetrySecretsStatement(secrets, "us-west-2")).toEqual({
      Sid: "BoxTelemetrySecrets",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: ["arn:aws:secretsmanager:us-west-2:*:secret:agentcore/demo/agent/box-??????"],
    });
  });

  test("takes the partition of the region", () => {
    const secrets = [{ name: "agentcore/demo/agent/box" }];

    expect(boxTelemetrySecretsStatement(secrets, "cn-north-1")?.Resource).toEqual([
      "arn:aws-cn:secretsmanager:cn-north-1:*:secret:agentcore/demo/agent/box-??????",
    ]);
  });

  test("is undefined with no secret", () => {
    expect(boxTelemetrySecretsStatement([], "us-west-2")).toBeUndefined();
  });
});

describe("boxTelemetrySecretEnvEntries", () => {
  const secrets = boxTelemetrySecrets("demo", [
    { runtime: "agent", thirdPartyTelemetry: [LANGSMITH] },
    { runtime: "other", thirdPartyTelemetry: [LANGFUSE] },
  ]);

  const entry = (value: string) => ({
    key: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH",
    value,
    comment:
      "Key for box telemetry [telemetry.langsmith] of 'agent' (env://LANGSMITH_KEY), " +
      "stored in AWS Secrets Manager on deploy",
  });

  test("copies the value of the profile's variable to the variable deploy reads", () => {
    const sources = { env: { LANGSMITH_KEY: "dummy-key" }, envLocal: {} };
    expect(boxTelemetrySecretEnvEntries(secrets, sources)).toEqual([
      {
        key: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH",
        value: "dummy-key",
        comment:
          "Key for box telemetry [telemetry.langsmith] of 'agent' (env://LANGSMITH_KEY), " +
          "stored in AWS Secrets Manager on deploy",
      },
    ]);
  });

  test("reads the variable from .env.local when the shell has no value for it, as dev does", () => {
    const envLocal = { LANGSMITH_KEY: "dummy-file-key" };

    expect(boxTelemetrySecretEnvEntries(secrets, { env: {}, envLocal })).toEqual([
      entry("dummy-file-key"),
    ]);
    expect(
      boxTelemetrySecretEnvEntries(secrets, { env: { LANGSMITH_KEY: " " }, envLocal }),
    ).toEqual([entry("dummy-file-key")]);
    expect(
      boxTelemetrySecretEnvEntries(secrets, {
        env: { LANGSMITH_KEY: "dummy-shell-key" },
        envLocal,
      }),
    ).toEqual([entry("dummy-shell-key")]);
  });

  test("writes nothing for a variable that is not set or is blank", () => {
    expect(boxTelemetrySecretEnvEntries(secrets, { env: {}, envLocal: {} })).toEqual([]);
    expect(
      boxTelemetrySecretEnvEntries(secrets, {
        env: { LANGSMITH_KEY: "  " },
        envLocal: { LANGSMITH_KEY: "" },
      }),
    ).toEqual([]);
  });
});
