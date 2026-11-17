import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BOX_BINARIES,
  BOX_RELEASE,
  boxCachePath,
  FFI_CACHE_MARKER,
  FFI_RELEASE,
  ffiCachePath,
} from "./boxRelease";

/**
 * Fills the caches under `home` with stand-ins of the pinned box release and ffi shims, so
 * build, deploy and dev find them and download nothing.
 */
export async function seedBoxCache(home: string): Promise<void> {
  const root = boxCachePath(home, BOX_RELEASE.version, BOX_RELEASE.linux.target);
  await mkdir(join(root, "resources", "shared"), { recursive: true });
  for (const binary of BOX_BINARIES) await writeFile(join(root, binary), `#!${binary}\n`);
  await writeFile(join(root, "release.json"), JSON.stringify({ box_version: BOX_RELEASE.version }));
  for (const [runtimeVersion, { sha256 }] of Object.entries(FFI_RELEASE.pythons)) {
    const ffi = ffiCachePath(home, FFI_RELEASE.version, runtimeVersion);
    await mkdir(ffi, { recursive: true });
    await writeFile(join(ffi, FFI_CACHE_MARKER), `${sha256}\n`);
  }
}
