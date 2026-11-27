/**
 * The release of a profile name that box bound to agentcore dev's copy of a profile. Box binds a
 * profile name to the first profile file that `box run` runs under it, in
 * `<box home>/storage/<name>/.profile-source`, and refuses every other file that declares the name.
 * An agentcore dev that gave its copy the local profile's name bound that name to the copy, so box
 * then refused the local profile for build and deploy. Dev now gives its copy a name of its own
 * (boxDevProfileName), and for a renamed profile Box says to remove the name's record.
 */
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { BOX_DEV_PROFILES_DIR, boxDevProfileName } from "../dev/boxDevTelemetry";

/** A profile name that box takes. */
const BOX_PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** An agent's name, which names the folder of its dev-time profile. */
const AGENT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The file in a profile name's storage folder that names the profile file box bound it to. */
const NAME_RECORD = ".profile-source";

/**
 * When `errorLines`, box's refusal of a profile, says that its name belongs to, or was recorded
 * for, agentcore dev's copy of a profile in `projectRoot`, and box's record of the name holds that
 * copy, removes that one record and returns what it did; else returns undefined and changes
 * nothing. `env` gives the box home: `BOX_HOME`, else `~/.strands/box`.
 */
export function releaseDevCopyName(
  errorLines: readonly string[],
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  // Box wraps its error at a space or inside a word, so the text is compared without white space.
  const text = errorLines.join("").replace(/\s+/g, "");
  const name = /theprofilename"([^"]+)"/.exec(text)?.[1];
  const home = boxHome(env);
  if (name === undefined || !BOX_PROFILE_NAME.test(name) || home === undefined) return undefined;
  const record = join(home, "storage", name, NAME_RECORD);
  let owner: string;
  try {
    owner = readFileSync(record, "utf8").trimEnd();
  } catch {
    return undefined;
  }
  const root = realPath(projectRoot);
  const copies = join(root, ...BOX_DEV_PROFILES_DIR.split("/"));
  const isDevCopy =
    dirname(dirname(owner)) === copies &&
    AGENT_NAME.test(basename(dirname(owner))) &&
    basename(owner) === "profile.toml";
  const named = owner.replace(/\s+/g, "");
  const refused = text.includes(`belongsto${named};`) || text.includes(`wasrecordedfor${named},`);
  if (!isDevCopy || !refused) return undefined;
  try {
    rmSync(record);
  } catch {
    return undefined;
  }
  const copy = relative(root, owner).split(sep).join("/");
  return (
    `Box had bound the profile name "${name}" to ${copy}, the copy that an earlier agentcore dev ` +
    `ran under that name. Removed ${record}, Box's record of that name, as Box says to do for a ` +
    `renamed profile. Dev now runs its copy as "${boxDevProfileName(name)}".`
  );
}

/** The folder box keeps its state in: `BOX_HOME` when set, else `~/.strands/box`. */
function boxHome(env: NodeJS.ProcessEnv): string | undefined {
  const set = env.BOX_HOME;
  if (set) return isAbsolute(set) ? set : undefined;
  return join(env.HOME || homedir(), ".strands", "box");
}

/** The path with every link resolved, or the path itself when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
