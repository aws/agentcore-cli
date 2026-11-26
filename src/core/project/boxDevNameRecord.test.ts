import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseDevCopyName } from "./boxDevNameRecord";
import { boxErrorLines } from "./boxProfileResolver-test-support";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A project folder `Demo`, and a box home with the record of the name `Demo-agent` holding `owner`. */
async function scene(owner?: (root: string) => string) {
  const folder = realpathSync(await mkdtemp(join(tmpdir(), "box-dev-name-")));
  directories.push(folder);
  const root = join(folder, "Demo");
  const boxHome = join(folder, "box-home");
  const local = join(root, ".box", "agent", "local", "profile.toml");
  const copy = join(root, "agentcore", ".cli", "box-dev", "agent", "profile.toml");
  const record = join(boxHome, "storage", "Demo-agent", ".profile-source");
  await mkdir(join(boxHome, "storage", "Demo-agent"), { recursive: true });
  await writeFile(record, `${owner ? owner(root) : copy}\n`);
  return { root, boxHome, local, copy, record, env: { BOX_HOME: boxHome } };
}

/** Box's refusal of `file` because the name `Demo-agent` belongs to `owner`, which declares it. */
const taken = (file: string, owner: string) =>
  boxErrorLines(
    `the profile name "Demo-agent" in ${file} belongs to ${owner}; give this profile another ` +
      "`[profile] name`",
  );

/** Box's refusal because the record of `Demo-agent` names `owner`, which no longer declares it. */
const gone = (owner: string, record: string) =>
  boxErrorLines(
    `the profile name "Demo-agent" was recorded for ${owner}, which no longer exists or no ` +
      "longer declares it; if you moved, renamed, or deleted that profile, remove " +
      `${record}, and run again`,
  );

describe("releaseDevCopyName", () => {
  test("removes the record of a name that belongs to dev's copy, and says what it removed", async () => {
    const { root, local, copy, record, env } = await scene();

    const note = releaseDevCopyName(taken(local, copy), root, env);

    expect(existsSync(record)).toBe(false);
    expect(note).toBe(
      'Box had bound the profile name "Demo-agent" to agentcore/.cli/box-dev/agent/profile.toml, ' +
        "the copy that an earlier agentcore dev ran under that name. Removed " +
        `${record}, Box's record of that name, as Box says to do for a renamed profile. ` +
        'Dev now runs its copy as "Demo-agent-dev".',
    );
  });

  test("removes the record of a name recorded for dev's copy, once the copy has its own name", async () => {
    const { root, copy, record, env } = await scene();

    expect(releaseDevCopyName(gone(copy, record), root, env)).toBeDefined();
    expect(existsSync(record)).toBe(false);
  });

  test("finds the box home in HOME when BOX_HOME is not set", async () => {
    const { root, boxHome, local, copy } = await scene();
    const home = join(boxHome, "..", "home");
    const record = join(home, ".strands", "box", "storage", "Demo-agent", ".profile-source");
    await mkdir(join(record, ".."), { recursive: true });
    await writeFile(record, `${copy}\n`);

    releaseDevCopyName(taken(local, copy), root, { HOME: home, BOX_HOME: "" });

    expect(existsSync(record)).toBe(false);
  });

  test("keeps a name that belongs to a profile file that is not dev's copy", async () => {
    const mine = (root: string) => join(root, "..", "mine", "profile.toml");
    const { root, local, record, env } = await scene(mine);

    expect(releaseDevCopyName(taken(local, mine(root)), root, env)).toBeUndefined();
    expect(existsSync(record)).toBe(true);
  });

  test("keeps a name that belongs to dev's copy in another project", async () => {
    const other = (root: string) =>
      join(root, "..", "Other", "agentcore", ".cli", "box-dev", "agent", "profile.toml");
    const { root, local, record, env } = await scene(other);

    expect(releaseDevCopyName(taken(local, other(root)), root, env)).toBeUndefined();
    expect(existsSync(record)).toBe(true);
  });

  test("keeps a record that names another file than the one Box refused for", async () => {
    const mine = (root: string) => join(root, "..", "mine", "profile.toml");
    const { root, local, copy, record, env } = await scene(mine);

    expect(releaseDevCopyName(taken(local, copy), root, env)).toBeUndefined();
    expect(existsSync(record)).toBe(true);
  });

  test("keeps the record for any other refusal by Box", async () => {
    const { root, local, record, env } = await scene();
    const refusal = boxErrorLines(`${local}:4: a profile holds no \`policy\``);

    expect(releaseDevCopyName(refusal, root, env)).toBeUndefined();
    expect(existsSync(record)).toBe(true);
  });
});
