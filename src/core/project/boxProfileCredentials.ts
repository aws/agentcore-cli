import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  credentialEnvVarName,
  CredentialNameSchema,
  type Credential,
} from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { EnvLocalEntry } from "../../handlers/project/types";

/** The box profile, relative to the project root. */
const BOX_PROFILE_RELATIVE_PATH = join(".box", "profile.toml");
const ENV_SCHEME = "env://";

/** An API key credential that {@link addBoxProfileCredentials} added, and the box env var it came from. */
export type AddedBoxCredential = { name: string; variable: string };

/** The environment variable a `secret.ref` names, when the ref is an `env://` reference. */
function envVarFromRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) return undefined;
  const variable = ref.slice(ENV_SCHEME.length);
  return variable.length > 0 ? variable : undefined;
}

/**
 * The `[egress.*]` table of the box profile, or `undefined` when the profile is absent, unreadable,
 * or has no egress routes. A malformed profile is the box's concern; build does not block on it.
 */
function readBoxProfileEgress(projectRoot: string): Record<string, unknown> | undefined {
  const profilePath = join(projectRoot, BOX_PROFILE_RELATIVE_PATH);
  if (!existsSync(profilePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(profilePath, "utf8"));
  } catch {
    return undefined;
  }
  const egress = (parsed as { egress?: Record<string, unknown> }).egress;
  return egress !== undefined && typeof egress === "object" ? egress : undefined;
}

/**
 * For each `[egress.<name>] secret.ref = "env://VAR"` in the box profile, make sure the project
 * declares an `ApiKeyCredentialProvider` named `<name>`. A later `agentcore deploy` then provisions
 * it in AgentCore Identity, so the key lives there and the runtime reads it from Identity rather
 * than from its own environment.
 *
 * Mutates `spec.credentials` in place. Returns one message per credential it adds, and the
 * `(name, variable)` pairs so the caller can seed the key into `.env.local`. Idempotent, and a
 * no-op when the profile is absent. It skips:
 *   - a non-`env://` ref (`aws://`, and so on), which names no API key;
 *   - a var an existing credential already covers (for example a model provider's key that
 *     `agentcore create` declared), so the key is provisioned once;
 *   - an egress name that is not a valid credential name, with a message, not a failure.
 */
export function addBoxProfileCredentials(
  spec: ProjectSpec,
  projectRoot: string,
): { messages: string[]; added: AddedBoxCredential[] } {
  const egress = readBoxProfileEgress(projectRoot);
  if (egress === undefined) return { messages: [], added: [] };

  const names = new Set(spec.credentials.map((credential) => credential.name));
  const coveredVars = new Set(
    spec.credentials
      .filter((credential) => credential.authorizerType === "ApiKeyCredentialProvider")
      .map((credential) => credentialEnvVarName(credential.name)),
  );

  const messages: string[] = [];
  const added: AddedBoxCredential[] = [];
  for (const [name, entry] of Object.entries(egress)) {
    const ref = (entry as { secret?: { ref?: unknown } } | null)?.secret?.ref;
    const variable = envVarFromRef(ref);
    if (variable === undefined) continue;
    if (coveredVars.has(variable)) continue;
    if (names.has(name)) continue;
    if (!CredentialNameSchema.safeParse(name).success) {
      messages.push(
        `skipping box egress '${name}' (env://${variable}): '${name}' is not a valid credential name`,
      );
      continue;
    }
    const credential: Credential = { authorizerType: "ApiKeyCredentialProvider", name };
    spec.credentials.push(credential);
    names.add(name);
    coveredVars.add(credentialEnvVarName(name));
    added.push({ name, variable });
    messages.push(
      `adding API key credential '${name}' to agentcore.json for box egress 'env://${variable}', ` +
        "so deploy provisions it in AgentCore Identity",
    );
  }
  return { messages, added };
}

/**
 * The `.env.local` entries that carry each added credential's key for deploy: the value of the box
 * env var the profile named, stored under the credential's reserved name. Only for vars that are
 * set and non-empty in `env`; a var that is not set is left for the operator, and deploy names it
 * if it is still missing. The box reads the same var locally, so this bridges local and deploy.
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

/**
 * Every `[egress.<name>] secret.ref = "env://VAR"` route in the box profile, as `(name, variable)`
 * pairs, for each `<name>` that is a valid credential name. Unlike {@link addBoxProfileCredentials},
 * this does not depend on what `agentcore.json` already declares, so build can seed each key on
 * every run from the var the profile names, not only the run that first adds the credential. A
 * no-op when the profile is absent.
 */
export function boxProfileEnvCredentials(projectRoot: string): AddedBoxCredential[] {
  const egress = readBoxProfileEgress(projectRoot);
  if (egress === undefined) return [];
  const credentials: AddedBoxCredential[] = [];
  for (const [name, entry] of Object.entries(egress)) {
    const ref = (entry as { secret?: { ref?: unknown } } | null)?.secret?.ref;
    const variable = envVarFromRef(ref);
    if (variable === undefined) continue;
    if (!CredentialNameSchema.safeParse(name).success) continue;
    credentials.push({ name, variable });
  }
  return credentials;
}
