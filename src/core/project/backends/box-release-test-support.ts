import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BOX_BINARIES, BOX_RELEASE, boxCachePath } from "./boxRelease";

/**
 * Fills the cache under `home` with a stand-in of the pinned box release, so build, deploy and
 * dev find it and download nothing.
 */
export async function seedBoxCache(home: string): Promise<void> {
  const root = boxCachePath(home, BOX_RELEASE.version, BOX_RELEASE.linux.target);
  await mkdir(join(root, "resources"), { recursive: true });
  await writeFile(join(root, "resources", "config.toml"), "");
  for (const binary of BOX_BINARIES) await writeFile(join(root, binary), `#!${binary}\n`);
  await writeFile(join(root, "release.json"), JSON.stringify({ box_version: BOX_RELEASE.version }));
}
