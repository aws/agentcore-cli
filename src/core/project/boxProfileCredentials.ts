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
import { ENV_LOCAL_RELATIVE_PATH } from "./envLocal";

/**
 * Where build looks for a route's key: the environment it runs in, and the project's `.env.local`,
 * where a user can keep a box variable under its own name, as `agentcore dev` reads it.
 */
export type BoxKeySources = {
  env: NodeJS.ProcessEnv;
  envLocal: Readonly<Record<string, string | undefined>>;
};

/** What {@link planBoxProfileCredentials} did with the box profile's `env://` routes. */
export type BoxCredentialPlan = {
  /** One message for each credential added, and for each route skipped for a reason to report. */
  messages: string[];
  /** The credentials added to `spec.credentials`. */
  added: Credential[];
  /** The `.env.local` entries that store each key under its credential's reserved variable. */
  entries: EnvLocalEntry[];
  /**
   * By route, why no API key credential holds the key of a route that gets none, and what to do,
   * in whole sentences.
   */
  unprovisioned: Map<string, string>;
};

/**
 * The credential that holds the key of the box egress `route` with `env://<variable>`, as
 * {@link planBoxProfileCredentials} names it: the credential that reserves `variable`, else the
 * one named `route`.
 */
export function boxEgressCredentialName(
  credentials: readonly Credential[],
  route: string,
  variable: string,
): string {
  const holder = credentials.find((credential) =>
    credentialEnvironmentVariableNames(credential).includes(variable),
  );
  return holder?.name ?? route;
}

/**
 * For each `[egress.<route>] secret.ref = "env://VAR"` route of the box profile, make sure the
 * project declares an `ApiKeyCredentialProvider` named `<route>`, and that `.env.local` holds its
 * key under the credential's reserved variable. A later `agentcore deploy` then provisions the
 * provider in AgentCore Identity.
 *
 * The key comes from the credential's reserved variable when it is already set, else from `VAR`,
 * in `sources.env` first and then in `sources.envLocal`. Deploy provisions every declared
 * credential and fails on one with no key, so a route whose key is in neither place gets no
 * credential: only a message that names the variable to set. A credential an earlier build added
 * is kept, and gets the same message if its key has gone.
 *
 * Mutates `spec.credentials` in place, and is idempotent. It skips, with no message:
 *   - a route whose variable an existing credential reserves: that credential holds the key;
 *   - a route named for an API key credential that keeps its key in Secrets Manager.
 *
 * A model-provider route that `agentcore create` writes with no key (`openai` reading
 * `OPENAI_API_KEY`) is a route like any other: on AgentCore Runtime its gateway target sends the
 * key of its credential.
 *
 * It skips, with a message, a route whose name `agentcore credentials add` would refuse: a name
 * that is not a valid credential name, that ends in a credential field suffix, that derives the
 * same variable as an existing credential, or that names a credential which is not an API key
 * credential.
 */
export function planBoxProfileCredentials(
  spec: ProjectSpec,
  routes: readonly BoxEnvRoute[],
  sources: BoxKeySources,
): BoxCredentialPlan {
  const reservedVars = new Map<string, string>();
  const reserve = (credential: Credential) => {
    for (const variable of credentialEnvironmentVariableNames(credential)) {
      reservedVars.set(variable, credential.name);
    }
  };
  for (const credential of spec.credentials) reserve(credential);
  // A credential that keeps its secret elsewhere reserves no variable, but its name still derives
  // one that a new credential must not take.
  const derivedVars = new Map(
    spec.credentials.map((credential) => [credentialEnvVarName(credential.name), credential.name]),
  );

  const messages: string[] = [];
  const added: Credential[] = [];
  const entries: EnvLocalEntry[] = [];
  const unprovisioned = new Map<string, string>();
  /**
   * Stores the route's key under `credential`'s reserved variable, as `agentcore dev` reads it: the
   * route's variable from the environment, else from `.env.local`. A stored key that differs is
   * replaced, so dev and deploy use the same key after a rotation. False when there is none.
   */
  const seed = ({ variable }: BoxEnvRoute, credential: string): boolean => {
    const key = credentialEnvVarName(credential);
    // Set in the environment itself, it is what deploy provisions; nothing to store.
    if (hasValue(sources.env[key])) return true;
    if (entries.some((entry) => entry.key === key)) return true;
    const value = hasValue(sources.env[variable])
      ? sources.env[variable]
      : sources.envLocal[variable];
    const stored = sources.envLocal[key];
    if (!hasValue(value)) return hasValue(stored);
    if (value === stored) return true;
    if (hasValue(stored)) {
      messages.push(
        `updating ${key} in ${ENV_LOCAL_RELATIVE_PATH}: ${variable} holds a different key, which ` +
          "agentcore dev uses, so deploy provisions it too",
      );
    }
    entries.push({
      key,
      value,
      comment: `API key for box egress 'env://${variable}', provisioned to AgentCore Identity on deploy`,
    });
    return true;
  };
  const toSet = (variable: string, credential: string) => {
    const key = credentialEnvVarName(credential);
    return variable === key ? variable : `${variable}, or ${key},`;
  };

  for (const entry of routes) {
    const { route, variable } = entry;
    if (reservedVars.has(variable)) continue;

    const skip = (reason: string, fix = "Rename the entry.") => {
      messages.push(`skipping box egress '${route}' (env://${variable}): ${reason}`);
      unprovisioned.set(route, `${reason[0]!.toUpperCase()}${reason.slice(1)}. ${fix}`);
    };
    const existing = spec.credentials.find((credential) => credential.name === route);
    if (existing !== undefined) {
      if (existing.authorizerType !== "ApiKeyCredentialProvider") {
        skip(`credential '${route}' is a ${existing.authorizerType} credential, not an API key`);
      } else if (credentialEnvironmentVariableNames(existing).length > 0 && !seed(entry, route)) {
        messages.push(
          `box egress '${route}' reads env://${variable}, which is not set here or in ` +
            `${ENV_LOCAL_RELATIVE_PATH}: set ${toSet(variable, route)} before deploy`,
        );
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
      .map((name) => reservedVars.get(name) ?? derivedVars.get(name))
      .find((owner) => owner !== undefined);
    if (clash !== undefined) {
      skip(
        `credential '${route}' would derive the same variable, ${credentialEnvVarName(route)}, ` +
          `as credential '${clash}'`,
      );
      continue;
    }
    if (!seed(entry, route)) {
      messages.push(
        `not adding credential '${route}' for box egress 'env://${variable}': ${variable} is not ` +
          `set here or in ${ENV_LOCAL_RELATIVE_PATH}, so deploy could not provision it. ` +
          `Set ${toSet(variable, route)} and build again`,
      );
      unprovisioned.set(
        route,
        `${variable} is not set here or in ${ENV_LOCAL_RELATIVE_PATH}. Set ` +
          `${toSet(variable, route)} and build again.`,
      );
      continue;
    }

    spec.credentials.push(credential);
    reserve(credential);
    derivedVars.set(credentialEnvVarName(route), route);
    added.push(credential);
    messages.push(
      `adding API key credential '${route}' to agentcore.json for box egress 'env://${variable}', ` +
        "so deploy provisions it in AgentCore Identity",
    );
  }
  return { messages, added, entries, unprovisioned };
}
