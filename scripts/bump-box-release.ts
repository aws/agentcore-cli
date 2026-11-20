#!/usr/bin/env bun

/**
 Pins box to a published GitHub release, in src/core/project/backends/boxRelease.json. It reads
 the release's SHA256SUMS.txt, so the file changes only to a version whose archives are published.
 It imports nothing from src/.

   bun scripts/bump-box-release.ts --box <version> [--box-repo <owner/repo>]
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

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    box: { type: "string" },
    "box-repo": { type: "string" },
  },
});
if (!values.box) {
  console.error("Name a version: --box <version>.");
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
const repo = values["box-repo"] ?? pinned.box.repo;
const version = values.box;
const sums = await checksums(repo, version);
const asset = `box-v${version}-${LINUX_TARGET}.tar.gz`;
const linux = sums.get(asset);
if (!linux) throw new Error(`${repo} v${version} lists no ${asset}`);
console.log(`box: ${pinned.box.repo} ${pinned.box.version} → ${repo} ${version}`);
const box = { repo, version, linux: { target: LINUX_TARGET, asset, sha256: linux } };

await Bun.write(FILE, `${JSON.stringify({ box }, null, 2)}\n`);
