/**
 * Writes the AWS Secrets Manager secret that holds the third-party telemetry keys of each box
 * runtime at deploy, and deletes the ones no runtime needs any more. The secrets are not stack
 * resources, as credential providers are not: no key goes into a template.
 */
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
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import type { BoxTelemetrySecret } from "../../boxTelemetrySecrets";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "../../envLocal";
import type { DeployedState } from "./deployedState";

/** The secrets deploy wrote for a target, by name. */
export type DeployedTelemetrySecrets = Record<string, { secretArn: string }>;

/** The days a deleted secret can be restored in; a later deploy restores it. */
const RECOVERY_WINDOW_DAYS = 7;

/** A secret as Secrets Manager describes it. */
interface DescribedSecret {
  readonly arn: string;
  /** Whether the secret is scheduled for deletion. */
  readonly deleted: boolean;
}

/** The Secrets Manager calls deploy makes, so a test stubs the client's `send` alone. */
export interface TelemetrySecretCalls {
  /** The secret that `secretId` (a name or an ARN) names, or undefined when there is none. */
  describe(secretId: string): Promise<DescribedSecret | undefined>;
  /** The secret string of the secret, or undefined when it holds none. */
  read(arn: string): Promise<string | undefined>;
  /** Creates the secret, and returns its ARN. */
  create(input: { name: string; value: string; description: string }): Promise<string>;
  put(arn: string, value: string): Promise<void>;
  restore(arn: string): Promise<void>;
  /** Schedules the deletion of the secret, with a recovery window. */
  delete(arn: string): Promise<void>;
}

/** The calls of {@link TelemetrySecretCalls} on one Secrets Manager client. */
export function secretsManagerCalls(client: SecretsManagerClient): TelemetrySecretCalls {
  return {
    async describe(secretId) {
      try {
        const described = await client.send(new DescribeSecretCommand({ SecretId: secretId }));
        if (!described.ARN) {
          throw new MalformedServiceResponseError(
            `Secrets Manager described secret '${secretId}' without an ARN.`,
          );
        }
        return { arn: described.ARN, deleted: described.DeletedDate !== undefined };
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return undefined;
        throw error;
      }
    },
    async read(arn) {
      const value = await client.send(new GetSecretValueCommand({ SecretId: arn }));
      return value.SecretString;
    },
    async create({ name, value, description }) {
      const created = await client.send(
        new CreateSecretCommand({ Name: name, SecretString: value, Description: description }),
      );
      if (!created.ARN) {
        throw new MalformedServiceResponseError(
          `Secrets Manager created secret '${name}' without an ARN.`,
        );
      }
      return created.ARN;
    },
    async put(arn, value) {
      await client.send(new PutSecretValueCommand({ SecretId: arn, SecretString: value }));
    },
    async restore(arn) {
      await client.send(new RestoreSecretCommand({ SecretId: arn }));
    },
    async delete(arn) {
      await client.send(
        new DeleteSecretCommand({ SecretId: arn, RecoveryWindowInDays: RECOVERY_WINDOW_DAYS }),
      );
    },
  };
}

/** The secrets `recorded` holds that `declared` no longer names. */
export function orphanedTelemetrySecrets(
  recorded: DeployedTelemetrySecrets,
  declared: readonly Pick<BoxTelemetrySecret, "name">[],
): DeployedTelemetrySecrets {
  const names = new Set(declared.map(({ name }) => name));
  return Object.fromEntries(Object.entries(recorded).filter(([name]) => !names.has(name)));
}

/**
 * The ARNs of the secrets that a target other than `targetName` records. Each deployment target
 * in one account and region shares a secret, so a deploy keeps the ones another target records.
 */
export function telemetrySecretsOfOtherTargets(
  state: DeployedState,
  targetName: string,
): Set<string> {
  return new Set(
    Object.entries(state.targets).flatMap(([name, target]) =>
      name === targetName
        ? []
        : Object.values(target.resources?.boxTelemetrySecrets ?? {}).map(
            ({ secretArn }) => secretArn,
          ),
    ),
  );
}

/** What deploy does with one secret: keep it as it is, or write its JSON object. */
type Plan = { readonly secret: BoxTelemetrySecret } & (
  | { readonly kind: "keep"; readonly arn: string }
  | { readonly kind: "create"; readonly value: string }
  | {
      readonly kind: "update";
      readonly arn: string;
      readonly restore: boolean;
      readonly value: string;
    }
);

/**
 * The string fields of the JSON object `text`, or an empty object when it is not one. Deploy
 * reads the secret back only to keep the value of a field whose key it does not have.
 */
function stringFields(text: string | undefined): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Decides what to write to one secret. With every key, deploy writes the whole object. Without
 * one, it reads the secret back and keeps the value its field holds, and keeps the secret as it
 * is when nothing changes. A key that neither deploy nor the secret holds fails the deploy.
 */
async function plan(
  calls: TelemetrySecretCalls,
  secret: BoxTelemetrySecret,
  env: Record<string, string | undefined>,
  rootPath: string,
): Promise<Plan> {
  const given = secret.fields.map((field) => ({
    ...field,
    value: env[field.variable] || undefined,
  }));
  const existing = await calls.describe(secret.name);
  // A secret scheduled for deletion cannot be read until a write restores it.
  let held: Record<string, string> = {};
  if (existing && !existing.deleted && given.some(({ value }) => value === undefined)) {
    held = stringFields(await calls.read(existing.arn));
  }
  const object: Record<string, string> = {};
  const missing: typeof given = [];
  for (const field of given) {
    const value = field.value ?? held[field.field];
    if (value === undefined) missing.push(field);
    else object[field.field] = value;
  }
  if (missing.length > 0) throw missingKeys(secret, missing, rootPath);
  const value = JSON.stringify(object);
  if (existing === undefined) return { secret, kind: "create", value };
  const unchanged =
    given.every(({ value }) => value === undefined) && isDeepStrictEqual(object, held);
  if (unchanged && !existing.deleted) return { secret, kind: "keep", arn: existing.arn };
  return { secret, kind: "update", arn: existing.arn, restore: existing.deleted, value };
}

/**
 * Writes the secret of each of `secrets`, and returns each one's ARN by name. Each secret is one
 * JSON object, with one field for each third-party telemetry target of its runtime. The key of
 * each target comes from its variable in `processEnv`, else in `agentcore/.env.local`, as a
 * credential's does. A secret is created when absent, and restored when it is scheduled for
 * deletion. Every secret is decided before the first write, so a missing key writes nothing. A
 * failure removes the secrets this deploy created.
 */
export async function* provisionTelemetrySecrets(
  calls: TelemetrySecretCalls,
  project: Project,
  secrets: readonly BoxTelemetrySecret[],
  processEnv: Record<string, string | undefined>,
): AsyncGenerator<ProjectEvent, DeployedTelemetrySecrets> {
  if (secrets.length === 0) return {};
  const needed = new Set(secrets.flatMap(({ fields }) => fields.map(({ variable }) => variable)));
  const env = await new EnvLocalFile(project.rootPath).read({
    select: (name) => needed.has(name),
    overrides: Object.fromEntries(Object.entries(processEnv).filter(([key]) => needed.has(key))),
  });

  const plans: Plan[] = [];
  for (const secret of secrets) plans.push(await plan(calls, secret, env, project.rootPath));

  const stored: DeployedTelemetrySecrets = {};
  const created: string[] = [];
  try {
    for (const plan of plans) {
      const { secret } = plan;
      yield {
        type: "step",
        message: `preparing secret '${secret.name}' for the box telemetry of '${secret.runtime}'`,
      };
      if (plan.kind === "keep") {
        stored[secret.name] = { secretArn: plan.arn };
        continue;
      }
      if (plan.kind === "create") {
        const arn = await calls.create({
          name: secret.name,
          value: plan.value,
          description:
            `The keys Box sends to the third-party telemetry targets of runtime ` +
            `'${secret.runtime}' of project '${project.spec.name}'. Written by agentcore deploy.`,
        });
        created.push(arn);
        stored[secret.name] = { secretArn: arn };
        continue;
      }
      if (plan.restore) await calls.restore(plan.arn);
      await calls.put(plan.arn, plan.value);
      stored[secret.name] = { secretArn: plan.arn };
    }
  } catch (error) {
    for (const arn of created.reverse()) {
      yield { type: "step", message: `removing secret ${arn}, which this deploy created` };
      try {
        await calls.delete(arn);
      } catch (cause) {
        yield {
          type: "step",
          message:
            `Could not remove secret ${arn}: ${(cause as Error).message}. It exists in AWS ` +
            "but is not recorded, so the next deploy of this target adopts it.",
        };
      }
    }
    throw error;
  }
  return stored;
}

/**
 * Schedules the deletion of each secret of `secrets`, except a secret that `kept` names, which
 * another deployment target records. A secret that is gone, or already scheduled for deletion, is
 * not an error. A secret that cannot be deleted is reported rather than failing the deploy that
 * already changed the stack, and comes back in the result so the caller can keep its record.
 */
export async function* removeTelemetrySecrets(
  calls: TelemetrySecretCalls,
  secrets: DeployedTelemetrySecrets,
  kept: ReadonlySet<string>,
): AsyncGenerator<ProjectEvent, DeployedTelemetrySecrets> {
  const failed: DeployedTelemetrySecrets = {};
  for (const [name, { secretArn }] of Object.entries(secrets)) {
    if (kept.has(secretArn)) {
      yield {
        type: "step",
        message: `keeping secret '${name}': another deployment target records it`,
      };
      continue;
    }
    try {
      const existing = await calls.describe(secretArn);
      if (existing === undefined || existing.deleted) continue;
      yield { type: "step", message: `deleting secret '${name}'` };
      await calls.delete(secretArn);
    } catch (error) {
      failed[name] = { secretArn };
      yield {
        type: "step",
        message: `Could not delete secret '${name}' (${secretArn}): ${(error as Error).message}.`,
      };
    }
  }
  return failed;
}

function missingKeys(
  secret: BoxTelemetrySecret,
  missing: readonly BoxTelemetrySecret["fields"][number][],
  rootPath: string,
): ProjectStateError {
  const targets = missing.map(({ target }) => `[telemetry.${target}]`).join(", ");
  const variables = missing.map(({ variable }) => variable).join(", ");
  const sources = missing.map(({ source }) => source).join(", ");
  return new ProjectStateError(
    `Runtime '${secret.runtime}' has no key for ${targets} to store in AWS Secrets Manager ` +
      `secret '${secret.name}'. Set ${variables} in ${join(rootPath, ENV_LOCAL_RELATIVE_PATH)} ` +
      `or in the environment you deploy from. Build copies ${sources} there when it is set.`,
  );
}
