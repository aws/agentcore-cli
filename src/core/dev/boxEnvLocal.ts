import type { EnvLocalEntry } from "../../handlers/project/types";
import { hasValue, readBoxEnvRoutes } from "../project/boxProfileEgress";
import { EnvLocalFile, ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";

/**
 * Writes into `agentcore/.env.local`, under its own name, each variable that a
 * `[egress.<name>] secret.ref = "env://<VAR>"` route of the agent's box profile
 * names and `env` holds, so `box run` finds it under `agentcore dev`, on the host
 * and in a container alike. A variable `.env.local` holds already keeps its value,
 * and one that is unset or blank in `env` is left out, so box names it. A profile
 * that does not parse has no routes here; `box run` reports it. Returns a message
 * for each variable it writes.
 */
export async function writeBoxDevEnvLocal(
  projectRoot: string,
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const routes = readBoxEnvRoutes(projectRoot, agentName)?.routes ?? [];

  const entries: (EnvLocalEntry & { route: string })[] = [];
  for (const { route, variable: key } of routes) {
    const value = env[key];
    if (!hasValue(value)) continue;
    if (entries.some((other) => other.key === key)) continue;
    entries.push({
      key,
      value,
      route,
      comment: `Key for box egress '${route}' (env://${key}), read by box under agentcore dev`,
    });
  }
  if (entries.length === 0) return [];

  const { written } = await new EnvLocalFile(projectRoot).insertIfNew(entries);
  return entries
    .filter(({ key }) => written.includes(key))
    .map(
      ({ key, route }) =>
        `writing ${key} to ${ENV_LOCAL_RELATIVE_PATH} for box egress '${route}' (env://${key})`,
    );
}
