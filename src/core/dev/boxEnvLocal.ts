import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import type { EnvLocalEntry } from "../../handlers/project/types";
import { EnvLocalFile, ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";
import { boxLocalProfilePath } from "../project/templates/boxProfile";

const ENV_SCHEME = "env://";

/**
 * Writes into `agentcore/.env.local`, under its own name, each variable that a
 * `[egress.<name>] secret.ref = "env://<VAR>"` route of the project's box profile
 * names and `env` holds, so `box run` finds it under `agentcore dev`, on the host
 * and in a container alike. A variable `.env.local` holds already keeps its value,
 * and one that is unset or blank in `env` is left out, so box names it. Returns a
 * message for each variable it writes.
 */
export async function writeBoxDevEnvLocal(
  projectRoot: string,
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const profile = boxLocalProfilePath(projectRoot, agentName);
  if (!existsSync(profile)) return [];
  const egress = ownEgress(await readFile(profile, "utf-8"));

  const entries: (EnvLocalEntry & { route: string })[] = [];
  for (const [route, entry] of Object.entries(egress)) {
    const ref = (entry as { secret?: { ref?: unknown } } | null)?.secret?.ref;
    if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) continue;
    const key = ref.slice(ENV_SCHEME.length);
    const value = env[key];
    if (key === "" || value === undefined || value.trim() === "") continue;
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

/**
 * The profile's own `[egress]` routes, without those its packs declare: a pack's
 * variable, such as box/bedrock's `AWS_BEARER_TOKEN_BEDROCK`, is not the profile
 * author's to store. A profile that does not parse has none here; `box run`
 * reports it.
 */
function ownEgress(text: string): Record<string, unknown> {
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch {
    return {};
  }
  const egress = table.egress;
  return typeof egress === "object" && egress !== null && !Array.isArray(egress)
    ? (egress as Record<string, unknown>)
    : {};
}
