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
  /** One step message for each credential added, and for each stored key replaced or filled in. */
  messages: string[];
  /**
   * One warning for each route skipped for a reason to report, and for each route whose key is in
   * no key source, so deploy could not provision its credential.
   */
  warnings: string[];
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

/** The rule for a credential name, as {@link CredentialNameSchema} checks it. */
export const CREDENTIAL_NAME_RULE =
  "A credential name has 3 to 128 characters, and only letters, digits, hyphens (-), and " +
  "underscores (_)";

/**
 * Why the box egress `route` cannot get the API key credential named `route` in a project with
 * `credentials`, as `agentcore credentials add` would refuse it: a name that is not a valid
 * credential name, that ends in a credential field suffix, that derives the same variable as a
 * credential of `credentials`, or that names a credential which is not an API key credential.
 * `undefined` when the credential can hold the route's key. The reason is one clause, with no
 * capital letter at its start and no full stop at its end.
 */
export function boxRouteCredentialProblem(
  credentials: readonly Credential[],
  route: string,
): string | undefined {
  const existing = credentials.find((credential) => credential.name === route);
  if (existing !== undefined) {
    if (existing.authorizerType === "ApiKeyCredentialProvider") return undefined;
    const article = /^[AEIOU]/.test(existing.authorizerType) ? "an" : "a";
    return `credential '${route}' is ${article} ${existing.authorizerType} credential, not an API key`;
  }
  if (!CredentialNameSchema.safeParse(route).success) {
    return `'${route}' is not a valid credential name. ${CREDENTIAL_NAME_RULE}`;
  }
  const suffix = credentialNameFieldSuffix(route);
  if (suffix !== undefined) {
    return (
      `'${route}' ends in '${suffix}', the suffix of a credential field, so its variable ` +
      `${credentialEnvVarName(route)} would read as a field of another credential`
    );
  }
  const wanted = credentialEnvironmentVariableNames({
    authorizerType: "ApiKeyCredentialProvider",
    name: route,
  });
  // A credential that keeps its secret elsewhere reserves no variable, but its name still derives
  // one that a new credential must not take.
  const clash = credentials.find(
    (credential) =>
      credentialEnvironmentVariableNames(credential).some((name) => wanted.includes(name)) ||
      wanted.includes(credentialEnvVarName(credential.name)),
  );
  if (clash !== undefined) {
    return (
      `credential '${route}' would derive the same variable, ${credentialEnvVarName(route)}, ` +
      `as credential '${clash.name}'`
    );
  }
  return undefined;
}

/**
 * Whether {@link planBoxProfileCredentials} skips `route` before it looks up any key, because
 * something else holds the key: a credential whose variables `reserved` holds reserves the route's
 * variable.
 */
function boxRouteKeyHeldElsewhere(
  { variable }: BoxEnvRoute,
  reserved: { has(variable: string): boolean },
): boolean {
  return reserved.has(variable);
}

/**
 * The variables {@link planBoxProfileCredentials} can look up in its key sources for `routes` in a
 * project with `credentials`: for each route it does not skip first, the route's `env://` variable
 * and the reserved variable of the credential named for the route. Build reads only these from
 * `.env.local`, so an entry no route uses cannot stop it. A credential that the planner adds for
 * one route can reserve the variable of a later route, which the set then still holds.
 */
export function boxKeyVariables(
  credentials: readonly Credential[],
  routes: readonly BoxEnvRoute[],
): Set<string> {
  const reserved = new Set(credentials.flatMap(credentialEnvironmentVariableNames));
  return new Set(
    routes
      .filter((route) => !boxRouteKeyHeldElsewhere(route, reserved))
      .flatMap(({ route, variable }) => [variable, credentialEnvVarName(route)]),
  );
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
 * credential: only a warning that names the variable to set. A credential an earlier build added
 * is kept, and gets the same warning if its key has gone. A model-provider route that
 * `agentcore create` writes with no key (`openai` reading `OPENAI_API_KEY`) is a route like any
 * other: on AgentCore Runtime its gateway target sends the key of its credential.
 *
 * Mutates `spec.credentials` in place, and is idempotent. It skips, with no message:
 *   - a route whose key something else holds ({@link boxRouteKeyHeldElsewhere});
 *   - a route named for an API key credential that keeps its key in Secrets Manager.
 *
 * It skips, with a warning, a route that {@link boxRouteCredentialProblem} refuses. Build and
 * deploy stop before this for such a route: the Box network model of each runtime refuses it, and
 * `readBoxNetworks` refuses a new credential that derives the variable of another runtime's. So
 * this skip is only a backstop.
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

  const messages: string[] = [];
  const warnings: string[] = [];
  const added: Credential[] = [];
  const entries: EnvLocalEntry[] = [];
  const unprovisioned = new Map<string, string>();
  /** The route variable whose key each stored entry holds, by the credential's variable. */
  const seededFrom = new Map<string, string>();
  /**
   * Stores the route's key under `credential`'s reserved variable, as `agentcore dev` reads it: the
   * route's variable from the environment, else from `.env.local`. A stored key that differs is
   * replaced, so dev and deploy use the same key after a rotation. False when there is none.
   */
  const seed = ({ route, variable }: BoxEnvRoute, credential: string): boolean => {
    const key = credentialEnvVarName(credential);
    const value = hasValue(sources.env[variable])
      ? sources.env[variable]
      : sources.envLocal[variable];
    // Set in the environment itself, it is what deploy provisions; nothing to store.
    if (hasValue(sources.env[key])) {
      if (hasValue(value) && value !== sources.env[key]) {
        warnings.push(
          `box egress '${route}': deploy provisions ${key} from the environment, but agentcore ` +
            `dev uses env://${variable}, which holds a different key, so dev and deploy can ` +
            `differ. Unset ${key}, or set it to the key in ${variable}`,
        );
      }
      return true;
    }
    // An earlier route of the same credential stored its key. Deploy provisions one key for the
    // credential, so a different key in this route's variable is not used.
    const earlier = entries.find((entry) => entry.key === key);
    if (earlier !== undefined) {
      const first = seededFrom.get(key);
      if (hasValue(value) && value !== earlier.value && first !== undefined) {
        warnings.push(
          `box egress '${route}': env://${variable} holds a different key than env://${first}, ` +
            `which build stored as ${key} for credential '${credential}', so deploy provisions ` +
            `the key in ${first} for both. Set ${variable} and ${first} to the same key`,
        );
      }
      return true;
    }
    const stored = sources.envLocal[key];
    if (!hasValue(value)) return hasValue(stored);
    if (value === stored) return true;
    if (hasValue(stored)) {
      messages.push(
        `updating ${key} in ${ENV_LOCAL_RELATIVE_PATH}: ${variable} holds a different key, which ` +
          "agentcore dev uses, so deploy provisions it too",
      );
    } else if (stored !== undefined) {
      messages.push(
        `filling in the blank ${key} in ${ENV_LOCAL_RELATIVE_PATH} with the key in ${variable}, ` +
          "so deploy provisions it",
      );
    }
    entries.push({
      key,
      value,
      comment: `API key for box egress 'env://${variable}', provisioned to AgentCore Identity on deploy`,
    });
    seededFrom.set(key, variable);
    return true;
  };
  const toSet = (variable: string, credential: string) => {
    const key = credentialEnvVarName(credential);
    return variable === key ? variable : `${variable}, or ${key},`;
  };

  for (const entry of routes) {
    const { route, variable } = entry;
    if (boxRouteKeyHeldElsewhere(entry, reservedVars)) continue;

    const skip = (reason: string, fix = "Rename the entry.") => {
      warnings.push(`skipping box egress '${route}' (env://${variable}): ${reason}`);
      unprovisioned.set(route, `${reason[0]!.toUpperCase()}${reason.slice(1)}. ${fix}`);
    };
    const problem = boxRouteCredentialProblem(spec.credentials, route);
    if (problem !== undefined) {
      skip(problem);
      continue;
    }
    const existing = spec.credentials.find((credential) => credential.name === route);
    if (existing !== undefined) {
      // An API key credential named for the route. One that keeps its key in Secrets Manager
      // reserves no variable, so build stores no key for it.
      if (credentialEnvironmentVariableNames(existing).length > 0 && !seed(entry, route)) {
        warnings.push(
          `box egress '${route}' reads env://${variable}, which is not set here or in ` +
            `${ENV_LOCAL_RELATIVE_PATH}: set ${toSet(variable, route)} before deploy`,
        );
      }
      continue;
    }
    const credential: Credential = { authorizerType: "ApiKeyCredentialProvider", name: route };
    if (!seed(entry, route)) {
      warnings.push(
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
    added.push(credential);
    messages.push(
      `adding API key credential '${route}' to agentcore.json for box egress 'env://${variable}', ` +
        "so deploy provisions it in AgentCore Identity",
    );
  }
  return { messages, warnings, added, entries, unprovisioned };
}
