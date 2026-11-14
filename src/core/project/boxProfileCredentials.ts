import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  credentialEnvVarName,
  CredentialNameSchema,
  type Credential,
} from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";

/** The box profile, relative to the project root. */
const BOX_PROFILE_RELATIVE_PATH = join(".box", "profile.toml");
const ENV_SCHEME = "env://";

/** The environment variable a `secret.ref` names, when the ref is an `env://` reference. */
function envVarFromRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) return undefined;
  const variable = ref.slice(ENV_SCHEME.length);
  return variable.length > 0 ? variable : undefined;
}

/**
 * For each `[egress.<name>] secret.ref = "env://VAR"` in the box profile, make sure the project
 * declares an `ApiKeyCredentialProvider` named `<name>`. A later `agentcore deploy` then provisions
 * it in AgentCore Identity, so the key lives there and the runtime reads it from Identity rather
 * than from its own environment.
 *
 * Mutates `spec.credentials` in place and returns one message per credential it adds. It is
 * idempotent, and a no-op when the profile is absent. It skips:
 *   - a non-`env://` ref (`aws://`, and so on), which names no API key;
 *   - a var an existing credential already covers (for example a model provider's key that
 *     `agentcore create` declared), so the key is provisioned once;
 *   - an egress name that is not a valid credential name, with a message, not a failure.
 */
export function addBoxProfileCredentials(spec: ProjectSpec, projectRoot: string): string[] {
  const profilePath = join(projectRoot, BOX_PROFILE_RELATIVE_PATH);
  if (!existsSync(profilePath)) return [];

  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(profilePath, "utf8"));
  } catch {
    // A malformed profile is the box's concern; build does not block on it here.
    return [];
  }
  const egress = (parsed as { egress?: Record<string, unknown> }).egress;
  if (egress === undefined || typeof egress !== "object") return [];

  const names = new Set(spec.credentials.map((credential) => credential.name));
  const coveredVars = new Set(
    spec.credentials
      .filter((credential) => credential.authorizerType === "ApiKeyCredentialProvider")
      .map((credential) => credentialEnvVarName(credential.name)),
  );

  const messages: string[] = [];
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
    messages.push(
      `adding API key credential '${name}' to agentcore.json for box egress 'env://${variable}', ` +
        "so deploy provisions it in AgentCore Identity",
    );
  }
  return messages;
}
