#!/usr/bin/env bun

/**
 Pins box, the box ffi shim, or both to a published GitHub release, in
 src/core/project/backends/boxRelease.json. It reads each release's SHA256SUMS.txt, so the file
 changes only to a version whose archives are published. It imports nothing from src/.

   bun scripts/bump-box-release.ts --box <version> [--box-repo <owner/repo>]
   bun scripts/bump-box-release.ts --ffi <version> [--ffi-repo <owner/repo>]
**/

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const FILE = join(
  resolve(import.meta.dir, ".."),
  "src",
  "core",
  "project",
  "backends",
  "boxRelease.json",
);
const LINUX_TARGET = "aarch64-unknown-linux-gnu";
/** The machines a box release may have a dev build for, as boxRelease.ts names them. */
const DEV_TARGETS: Record<string, string> = { "darwin-arm64": "aarch64-apple-darwin" };
/** box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz is the shim for PYTHON_3_14. */
const FFI_ASSET = new RegExp(`^box-ffi-python(\\d+)\\.(\\d+)-${LINUX_TARGET}\\.tar\\.gz$`);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    box: { type: "string" },
    "box-repo": { type: "string" },
    ffi: { type: "string" },
    "ffi-repo": { type: "string" },
  },
});
if (!values.box && !values.ffi) {
  console.error("Name a version: --box <version>, --ffi <version>, or both.");
  process.exit(2);
}

/** The SHA-256 of each asset of a release, from its SHA256SUMS.txt. */
async function checksums(repo: string, version: string): Promise<Map<string, string>> {
  const url = `https://github.com/${repo}/releases/download/v${version}/SHA256SUMS.txt`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const sums = new Map<string, string>();
  for (const line of (await response.text()).split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

const pinned = await Bun.file(FILE).json();

if (values.box) {
  const repo = values["box-repo"] ?? pinned.box.repo;
  const version = values.box;
  const sums = await checksums(repo, version);
  const asset = (target: string) => `box-v${version}-${target}.tar.gz`;
  const linux = sums.get(asset(LINUX_TARGET));
  if (!linux) throw new Error(`${repo} v${version} lists no ${asset(LINUX_TARGET)}`);
  const dev: Record<string, unknown> = {};
  for (const [machine, target] of Object.entries(DEV_TARGETS)) {
    const sha256 = sums.get(asset(target));
    if (sha256) dev[machine] = { target, asset: asset(target), sha256 };
    else console.warn(`warning: ${repo} v${version} has no dev build for ${machine}`);
  }
  console.log(`box: ${pinned.box.repo} ${pinned.box.version} → ${repo} ${version}`);
  pinned.box = {
    repo,
    version,
    linux: { target: LINUX_TARGET, asset: asset(LINUX_TARGET), sha256: linux },
    dev,
  };
}

if (values.ffi) {
  const repo = values["ffi-repo"] ?? pinned.ffi.repo;
  const version = values.ffi;
  const sums = await checksums(repo, version);
  const pythons: Record<string, unknown> = {};
  for (const [asset, sha256] of sums) {
    const match = FFI_ASSET.exec(asset);
    if (match) pythons[`PYTHON_${match[1]}_${match[2]}`] = { asset, sha256 };
  }
  if (Object.keys(pythons).length === 0) {
    throw new Error(`${repo} v${version} lists no box-ffi-python*-${LINUX_TARGET}.tar.gz`);
  }
  console.log(
    `ffi: ${pinned.ffi.repo} ${pinned.ffi.version} → ${repo} ${version} ` +
      `(${Object.keys(pythons).join(", ")})`,
  );
  pinned.ffi = { repo, version, pythons };
}

await Bun.write(FILE, `${JSON.stringify(pinned, null, 2)}\n`);
