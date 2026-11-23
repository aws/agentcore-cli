import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BOX_BINARIES, BOX_RELEASE, boxCachePath, type BoxRelease } from "./boxRelease";

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

/** A second supported box release, for tests of a runtime whose box.version is not the default. */
export const OTHER_BOX_RELEASE: BoxRelease = {
  ...BOX_RELEASE,
  version: "9.9.9-test.1",
  linux: {
    ...BOX_RELEASE.linux,
    asset: "box-v9.9.9-test.1-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "1".repeat(64),
  },
};

/** The supported releases of those tests: the default, then {@link OTHER_BOX_RELEASE}. */
export const TEST_BOX_RELEASES: readonly BoxRelease[] = [BOX_RELEASE, OTHER_BOX_RELEASE];
