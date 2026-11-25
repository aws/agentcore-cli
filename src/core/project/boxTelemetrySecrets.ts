/**
 * The AWS Secrets Manager secret that holds the keys of the third-party telemetry targets of a box
 * runtime. Locally, Box reads a target's key from a variable of its environment (`env://VAR`). On
 * AgentCore Runtime that variable does not exist, so deploy stores the key in one JSON secret for
 * each runtime, which the CLI owns, with one field for each target. The AgentCore Runtime profile
 * names that field, and the execution role can read that secret. Box reads it at the start of a run
 * through its `@box/aws-secrets-manager` plugin, which runs the AWS CLI.
 */
import { partition } from "@aws-sdk/util-endpoints";
import type { EnvLocalEntry } from "../../handlers/project/types";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import type { BoxNetwork, ThirdPartyTelemetry } from "./boxNetwork";
import type { BoxKeySources } from "./boxProfileCredentials";
import { hasValue } from "./boxProfileEgress";

/** The Box plugin that reads `aws-secretsmanager://` references. Only the profile may list it. */
export const BOX_SECRETS_MANAGER_PLUGIN = "@box/aws-secrets-manager";

/** The scheme Box reads a secret from AWS Secrets Manager with: `aws-secretsmanager://ID#FIELD`. */
export const SECRETS_MANAGER_SCHEME = "aws-secretsmanager://";

/**
 * The name of the secret that holds the telemetry keys of runtime `runtime`. Each deployment target
 * of the project in one account and region shares it, because the AgentCore Runtime profile is the
 * same for each one. Box takes the region of a secret that it reads by name from `AWS_REGION`,
 * which the Runtime sets.
 */
export function boxTelemetrySecretName(project: string, runtime: string): string {
  return `agentcore/${project}/${runtime}/box`;
}

/** The field of the runtime's secret that holds the key of `[telemetry.<target>]`. */
export function boxTelemetrySecretField(target: string): string {
  return `telemetry.${target}`;
}

/**
 * The variable deploy reads the key of `[telemetry.<target>]` of runtime `runtime` from, in the
 * environment and then in `agentcore/.env.local`, as it reads a credential's.
 */
export function boxTelemetrySecretVariable(runtime: string, target: string): string {
  return credentialEnvVarName(`${runtime}_TELEMETRY_${target}`);
}

/** The `secret.ref` of a target on AgentCore Runtime: one field of the runtime's secret. */
export function boxTelemetrySecretRef(name: string, field: string): string {
  return `${SECRETS_MANAGER_SCHEME}${name}#${field}`;
}

/** One field of a runtime's secret: the key of one third-party telemetry target. */
export interface BoxTelemetrySecretField {
  /** The `<name>` of the `[telemetry.<name>]` table. */
  readonly target: string;
  /** The field of the secret's JSON object. */
  readonly field: string;
  /** The variable deploy reads the key from. */
  readonly variable: string;
  /** The variable the box profile reads the key from locally (`env://<source>`). */
  readonly source: string;
}

/** The secret deploy writes for the third-party telemetry targets of one runtime. */
export interface BoxTelemetrySecret {
  readonly runtime: string;
  /** The name of the secret in AWS Secrets Manager. */
  readonly name: string;
  /** One field for each target with a key, in profile order. */
  readonly fields: readonly BoxTelemetrySecretField[];
}

/** The secret of each box runtime with a third-party telemetry target that has a key, in order. */
export function boxTelemetrySecrets(
  project: string,
  networks: readonly Pick<BoxNetwork, "runtime" | "thirdPartyTelemetry">[],
): BoxTelemetrySecret[] {
  return networks.flatMap(({ runtime, thirdPartyTelemetry }) => {
    const fields = (thirdPartyTelemetry ?? []).flatMap((target) => {
      const field = boxTelemetrySecretFieldOf(runtime, target);
      return field ? [field] : [];
    });
    return fields.length > 0
      ? [{ runtime, name: boxTelemetrySecretName(project, runtime), fields }]
      : [];
  });
}

/** The field of `target` of runtime `runtime`, or undefined when it has no key. */
function boxTelemetrySecretFieldOf(
  runtime: string,
  target: ThirdPartyTelemetry,
): BoxTelemetrySecretField | undefined {
  if (target.secret === undefined) return undefined;
  return {
    target: target.name,
    field: boxTelemetrySecretField(target.name),
    variable: boxTelemetrySecretVariable(runtime, target.name),
    source: target.secret.variable,
  };
}

/**
 * The statement that lets the execution role read the secrets of `secrets`, and no other secret,
 * or undefined when there are none. Build has no account, so each ARN matches any account.
 * Secrets Manager adds `-` and six characters to the name of a secret in its ARN. The secret is
 * encrypted with the AWS managed key, which needs no `kms:Decrypt` grant.
 */
export function boxTelemetrySecretsStatement(
  secrets: readonly Pick<BoxTelemetrySecret, "name">[],
  region: string,
): Record<string, unknown> | undefined {
  if (secrets.length === 0) return undefined;
  const arn = (name: string) =>
    `arn:${partition(region).name}:secretsmanager:${region}:*:secret:${name}-??????`;
  return {
    Sid: "BoxTelemetrySecrets",
    Effect: "Allow",
    Action: ["secretsmanager:GetSecretValue"],
    Resource: [...new Set(secrets.map(({ name }) => arn(name)))],
  };
}

/**
 * The `.env.local` entries that carry each key for deploy: the value of the variable the box
 * profile names, under the variable deploy reads. Build takes the value from the shell when it is
 * set and not empty. If not, build takes it from `.env.local`, the same as for the API key of a box
 * route and the same as dev.
 */
export function boxTelemetrySecretEnvEntries(
  secrets: readonly BoxTelemetrySecret[],
  sources: BoxKeySources,
): EnvLocalEntry[] {
  const entries: EnvLocalEntry[] = [];
  for (const { runtime, fields } of secrets) {
    for (const { target, variable, source } of fields) {
      const value = hasValue(sources.env[source]) ? sources.env[source] : sources.envLocal[source];
      if (!hasValue(value)) continue;
      if (entries.some(({ key }) => key === variable)) continue;
      entries.push({
        key: variable,
        value,
        comment:
          `Key for box telemetry [telemetry.${target}] of '${runtime}' (env://${source}), ` +
          "stored in AWS Secrets Manager on deploy",
      });
    }
  }
  return entries;
}
