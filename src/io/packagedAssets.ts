import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/** Read a file's raw bytes, or undefined when it is absent or unreadable. */
export async function readOptionalBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * The directory a resolvable package file sits in, or undefined when the
 * package is not installed. Keeps node:module out of the domain layer that
 * resolves bundled dependencies at runtime.
 */
export function resolvePackageFileDir(specifier: string): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve(specifier));
  } catch {
    return undefined;
  }
}
