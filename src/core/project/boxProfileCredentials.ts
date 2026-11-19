import {
  credentialEnvironmentVariableNames,
  credentialEnvVarName,
  credentialNameFieldSuffix,
  CredentialNameSchema,
  type Credential,
} from "../../projectSchemas/credential";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { EnvLocalEntry } from "../../handlers/project/types";
import { hasValue, type BoxEnvRoute } from "./boxProfileEgress";
import { MODEL_PROVIDER_EGRESS_ROUTES, MODEL_PROVIDER_KEY_VARIABLES } from "./templates/boxProfile";

/**
 * A box `env://` route whose key deploy reads from the API key credential `credential`, under
 * that credential's reserved variable.
 */
export type BoxCredentialSeed = BoxEnvRoute & { credential: string };

/** What {@link planBoxProfileCredentials} did with the box profile's `env://` routes. */
export type BoxCredentialPlan = {
  /** One message for each credential added, and for each route skipped for a reason to report. */
  messages: string[];
  /** The credentials added to `spec.credentials`. */
  added: Credential[];
  /** Every route an API key credential of the project now covers by its name, added or not. */
  seeds: BoxCredentialSeed[];
};

/**
 * For each `[egress.<route>] secret.ref = "env://VAR"` route of the box profile, make sure the
 * project declares an `ApiKeyCredentialProvider` named `<route>`. A later `agentcore deploy` then
 * provisions it in AgentCore Identity, so the key lives there and the runtime reads it from
 * Identity rather than from its own environment.
 *
 * Mutates `spec.credentials` in place, and is idempotent. It skips, with no message:
 *   - a model-provider route that `agentcore create` wrote, or one that reads a provider variable
 *     (such as `OPENAI_API_KEY`): its key is the project's model-provider credential, or a variable
 *     LiteLLM reads, so a credential here would only make deploy ask for a key nothing uses;
 *   - a route whose variable is an existing API key credential's reserved variable: that
 *     credential already holds the key under that variable.
 *
 * It skips, with a message, and with no failure, a route whose name `agentcore credentials add`
 * would refuse: a name that is not a valid credential name, that ends in a credential field suffix,
 * that derives the same variable as an existing credential, or that names a credential which is
 * not an API key credential.
 *
 * `seeds` lists each route whose key deploy reads from an API key credential named for the route:
 * the ones this call adds, and the ones an earlier build added. So build seeds the key on every
 * run, from one filter.
 */
export function planBoxProfileCredentials(
  spec: ProjectSpec,
  routes: readonly BoxEnvRoute[],
): BoxCredentialPlan {
  const reservedVars = new Map<string, string>();
  for (const credential of spec.credentials) {
    for (const variable of credentialEnvironmentVariableNames(credential)) {
      reservedVars.set(variable, credential.name);
    }
    // A credential that keeps its secret elsewhere still owns its base variable's name.
    reservedVars.set(credentialEnvVarName(credential.name), credential.name);
  }
  const apiKeyVars = new Set(
    spec.credentials
      .filter((credential) => credential.authorizerType === "ApiKeyCredentialProvider")
      .map((credential) => credentialEnvVarName(credential.name)),
  );

  const messages: string[] = [];
  const added: Credential[] = [];
  const seeds: BoxCredentialSeed[] = [];
  for (const { route, variable } of routes) {
    if (MODEL_PROVIDER_EGRESS_ROUTES.has(route) || MODEL_PROVIDER_KEY_VARIABLES.has(variable)) {
      continue;
    }
    if (apiKeyVars.has(variable)) continue;

    const skip = (reason: string) =>
      messages.push(`skipping box egress '${route}' (env://${variable}): ${reason}`);
    const existing = spec.credentials.find((credential) => credential.name === route);
    if (existing !== undefined) {
      if (existing.authorizerType === "ApiKeyCredentialProvider") {
        seeds.push({ route, variable, credential: route });
      } else {
        skip(`credential '${route}' is a ${existing.authorizerType} credential, not an API key`);
      }
      continue;
    }
    if (!CredentialNameSchema.safeParse(route).success) {
      skip(`'${route}' is not a valid credential name`);
      continue;
    }
    const suffix = credentialNameFieldSuffix(route);
    if (suffix !== undefined) {
      skip(
        `'${route}' ends in '${suffix}', the suffix of a credential field, so its variable ` +
          `${credentialEnvVarName(route)} would read as a field of another credential`,
      );
      continue;
    }
    const credential: Credential = { authorizerType: "ApiKeyCredentialProvider", name: route };
    const clash = credentialEnvironmentVariableNames(credential)
      .map((name) => reservedVars.get(name))
      .find((owner) => owner !== undefined);
    if (clash !== undefined) {
      skip(
        `credential '${route}' would derive the same variable, ${credentialEnvVarName(route)}, ` +
          `as credential '${clash}'`,
      );
      continue;
    }

    spec.credentials.push(credential);
    for (const name of credentialEnvironmentVariableNames(credential)) {
      reservedVars.set(name, route);
    }
    apiKeyVars.add(credentialEnvVarName(route));
    added.push(credential);
    seeds.push({ route, variable, credential: route });
    messages.push(
      `adding API key credential '${route}' to agentcore.json for box egress 'env://${variable}', ` +
        "so deploy provisions it in AgentCore Identity",
    );
  }
  return { messages, added, seeds };
}

/** The `.env.local` entries for {@link planBoxProfileCredentials}'s seeds, and the seeds with no key. */
export type BoxCredentialSeedEntries = {
  entries: EnvLocalEntry[];
  /** The seeds whose key is in neither source, and not yet under the credential's variable. */
  missing: BoxCredentialSeed[];
};

/**
 * The `.env.local` entries that carry each seed's key for deploy: the value of the route's box
 * variable, under the credential's reserved variable. The value comes from `env` first, then from
 * `envLocal` under the box variable's own name, where `agentcore dev` stores it. A seed whose
 * reserved variable is already set in either source needs no entry. A seed with no value in either
 * source is in `missing`, so build can name the variable before deploy fails on it.
 */
export function boxCredentialSeedEntries(
  seeds: readonly BoxCredentialSeed[],
  env: NodeJS.ProcessEnv,
  envLocal: Readonly<Record<string, string | undefined>>,
): BoxCredentialSeedEntries {
  const entries: EnvLocalEntry[] = [];
  const missing: BoxCredentialSeed[] = [];
  for (const seed of seeds) {
    const key = credentialEnvVarName(seed.credential);
    if (hasValue(env[key]) || hasValue(envLocal[key])) continue;
    if (entries.some((entry) => entry.key === key)) continue;
    const value = hasValue(env[seed.variable]) ? env[seed.variable] : envLocal[seed.variable];
    if (!hasValue(value)) {
      missing.push(seed);
      continue;
    }
    entries.push({
      key,
      value,
      comment: `API key for box egress 'env://${seed.variable}', provisioned to AgentCore Identity on deploy`,
    });
  }
  return { entries, missing };
}
