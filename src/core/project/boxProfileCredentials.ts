import {
  credentialEnvVarName,
  CredentialNameSchema,
  type Credential,
} from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { EnvLocalEntry } from "../../handlers/project/types";

const ENV_SCHEME = "env://";

/** An API key credential that a box egress route needs, and the box env var that holds its key. */
export type AddedBoxCredential = { name: string; variable: string };

/** The environment variable a `secret.ref` names, when the ref is an `env://` reference. */
function envVarFromRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) return undefined;
  const variable = ref.slice(ENV_SCHEME.length);
  return variable.length > 0 ? variable : undefined;
}

/**
 * The API key credential that holds the key of `[egress.<name>]` with `env://<variable>`: the one
 * whose reserved variable is `variable`, else the one named `<name>`, else `<name>` when it is a
 * credential name that no credential holds, which build then declares. `undefined` otherwise.
 */
export function boxEgressCredentialName(
  credentials: readonly Credential[],
  name: string,
  variable: string,
): string | undefined {
  const apiKeys = credentials.filter(
    (credential) => credential.authorizerType === "ApiKeyCredentialProvider",
  );
  const declared =
    apiKeys.find((credential) => credentialEnvVarName(credential.name) === variable) ??
    apiKeys.find((credential) => credential.name === name);
  if (declared) return declared.name;
  const free = !credentials.some((credential) => credential.name === name);
  return free && CredentialNameSchema.safeParse(name).success ? name : undefined;
}

/**
 * The API key credential each `[egress.<name>] secret.ref = "env://VAR"` route of `egress` needs,
 * named by {@link boxEgressCredentialName}, and a message for each route it cannot name. A
 * non-`env://` ref (`aws://`, and so on) names no API key, and a var that an existing credential
 * already covers (for example a model provider's key that `agentcore create` declared) needs no
 * second one.
 */
export function boxEgressCredentials(
  egress: Readonly<Record<string, unknown>>,
  credentials: readonly Credential[],
): { needed: AddedBoxCredential[]; skipped: string[] } {
  const needed: AddedBoxCredential[] = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(egress)) {
    const ref = (entry as { secret?: { ref?: unknown } } | null)?.secret?.ref;
    const variable = envVarFromRef(ref);
    if (variable === undefined) continue;
    const credential = boxEgressCredentialName(credentials, name, variable);
    if (credential === undefined) {
      skipped.push(
        `skipping box egress '${name}' (env://${variable}): '${name}' is not a valid credential name`,
      );
      continue;
    }
    if (!needed.some((other) => other.name === credential)) {
      needed.push({ name: credential, variable });
    }
  }
  return { needed, skipped };
}

/**
 * Declares in `spec` each of `needed` that it does not declare yet, as an
 * `ApiKeyCredentialProvider`, so a later `agentcore deploy` provisions it in AgentCore Identity and
 * the runtime reads the key from Identity rather than from its own environment. Returns one message
 * for each credential it adds.
 */
export function addBoxEgressCredentials(
  spec: ProjectSpec,
  needed: readonly AddedBoxCredential[],
): string[] {
  const messages: string[] = [];
  for (const { name, variable } of needed) {
    if (spec.credentials.some((credential) => credential.name === name)) continue;
    spec.credentials.push({ authorizerType: "ApiKeyCredentialProvider", name });
    messages.push(
      `adding API key credential '${name}' to agentcore.json for box egress 'env://${variable}', ` +
        "so deploy provisions it in AgentCore Identity",
    );
  }
  return messages;
}

/**
 * The `.env.local` entries that carry each credential's key for deploy: the value of the box env
 * var the profile named, stored under the credential's reserved name. Only for vars that are set
 * and non-empty in `env`; a var that is not set is left for the operator, and deploy names it if
 * it is still missing. The box reads the same var locally, so this bridges local and deploy.
 */
export function boxProfileCredentialEnvEntries(
  added: readonly AddedBoxCredential[],
  env: NodeJS.ProcessEnv,
): EnvLocalEntry[] {
  const entries: EnvLocalEntry[] = [];
  for (const { name, variable } of added) {
    const value = env[variable];
    if (value === undefined || value === "") continue;
    entries.push({
      key: credentialEnvVarName(name),
      value,
      comment: `API key for box egress 'env://${variable}', provisioned to AgentCore Identity on deploy`,
    });
  }
  return entries;
}
