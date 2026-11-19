import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { boxLocalProfilePath } from "./templates/boxProfile";

const ENV_SCHEME = "env://";

/** An `[egress.<route>]` of the box profile whose `secret.ref` is `env://<variable>`. */
export type BoxEnvRoute = { route: string; variable: string };

/**
 * The `env://` routes of a box profile. `error` is set when the profile does not parse; `routes`
 * is then empty.
 */
export type BoxEnvRoutes = { routes: BoxEnvRoute[]; error?: string };

/**
 * The profile's own `[egress]` routes whose `secret.ref` is an `env://` reference, in profile
 * order. A pack's routes, such as @box/bedrock's, are not in the profile's own `[egress]` table, so
 * they are not here. An `egress` that is not a table (an array of tables, or a scalar) has no
 * routes, and nor does a ref with no variable after `env://`.
 */
export function parseBoxEnvRoutes(text: string): BoxEnvRoutes {
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    return { routes: [], error: error instanceof Error ? error.message : String(error) };
  }
  const egress = table.egress;
  if (typeof egress !== "object" || egress === null || Array.isArray(egress)) {
    return { routes: [] };
  }
  const routes: BoxEnvRoute[] = [];
  for (const [route, entry] of Object.entries(egress as Record<string, unknown>)) {
    const ref = (entry as { secret?: { ref?: unknown } } | null)?.secret?.ref;
    if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) continue;
    const variable = ref.slice(ENV_SCHEME.length);
    if (variable.trim() === "") continue;
    routes.push({ route, variable });
  }
  return { routes };
}

/**
 * The `env://` routes of the local box profile of agent `agentName` in the project at
 * `projectRoot`, or `undefined` when the agent has no local box profile.
 */
export function readBoxEnvRoutes(projectRoot: string, agentName: string): BoxEnvRoutes | undefined {
  const path = boxLocalProfilePath(projectRoot, agentName);
  if (!existsSync(path)) return undefined;
  return parseBoxEnvRoutes(readFileSync(path, "utf8"));
}

/** Whether an environment value holds a key: set, and not blank. */
export function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
