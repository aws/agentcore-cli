import { describe, expect, test } from "bun:test";
import type { ThirdPartyTelemetry } from "./boxNetwork";
import {
  boxSecretsManagerEnabled,
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

describe("boxSecretsManagerEnabled", () => {
  test("is on only for 1, so the Runtime profile keeps today's form by default", () => {
    expect(boxSecretsManagerEnabled({ AGENTCORE_BOX_SECRETS_MANAGER: "1" })).toBe(true);
    expect(boxSecretsManagerEnabled({})).toBe(false);
    expect(boxSecretsManagerEnabled({ AGENTCORE_BOX_SECRETS_MANAGER: "true" })).toBe(false);
  });
});

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

  test("copies the value of the profile's variable to the variable deploy reads", () => {
    expect(boxTelemetrySecretEnvEntries(secrets, { LANGSMITH_KEY: "dummy-key" })).toEqual([
      {
        key: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH",
        value: "dummy-key",
        comment:
          "Key for box telemetry [telemetry.langsmith] of 'agent' (env://LANGSMITH_KEY), " +
          "stored in AWS Secrets Manager on deploy",
      },
    ]);
  });

  test("writes nothing for a variable that is not set or is blank", () => {
    expect(boxTelemetrySecretEnvEntries(secrets, {})).toEqual([]);
    expect(boxTelemetrySecretEnvEntries(secrets, { LANGSMITH_KEY: "  " })).toEqual([]);
  });
});
