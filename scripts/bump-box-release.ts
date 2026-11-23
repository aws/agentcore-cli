#!/usr/bin/env bun

/**
 Pins the box releases this CLI supports, in src/core/project/backends/boxRelease.json: for each,
 the Linux arm64 build that ships to AgentCore Runtime and the macOS arm64 build that the e2e
 workflow installs on its macOS runner. `box` is the default release, which `agentcore create`
 writes; `supported` lists the other releases a runtime's box.version can name. It reads each
 release's SHA256SUMS.txt, so the file changes only to versions whose archives are published, and
 the checksums it pins reach the CLI only through a reviewed change of the file. It imports nothing
 from src/.

   bun scripts/bump-box-release.ts --box <version> [--keep-previous] [--box-repo <owner/repo>]
   bun scripts/bump-box-release.ts --add <version> [--box-repo <owner/repo>]
   bun scripts/bump-box-release.ts --remove <version>

 --box makes <version> the default; --keep-previous keeps the old default as a supported release.
 --add supports <version> beside the default, and --remove stops supporting it.
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
const DARWIN_TARGET = "aarch64-apple-darwin";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    box: { type: "string" },
    add: { type: "string" },
    remove: { type: "string" },
    "keep-previous": { type: "boolean" },
    "box-repo": { type: "string" },
  },
});
if ([values.box, values.add, values.remove].filter(Boolean).length !== 1) {
  console.error("Name one change: --box <version>, --add <version>, or --remove <version>.");
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

type Release = {
  repo: string;
  version: string;
  linux: { target: string; asset: string; sha256: string };
  darwin: { target: string; asset: string; sha256: string };
};

/** `version` of `repo`, with the pinned archive of each target, which the release must list. */
async function release(repo: string, version: string): Promise<Release> {
  const sums = await checksums(repo, version);
  const pin = (target: string) => {
    const asset = `box-v${version}-${target}.tar.gz`;
    const sha256 = sums.get(asset);
    if (!sha256) throw new Error(`${repo} v${version} lists no ${asset}`);
    return { target, asset, sha256 };
  };
  return { repo, version, linux: pin(LINUX_TARGET), darwin: pin(DARWIN_TARGET) };
}

const pinned = (await Bun.file(FILE).json()) as { box: Release; supported?: Release[] };
const repo = values["box-repo"] ?? pinned.box.repo;
let box = pinned.box;
let supported = (pinned.supported ?? []).filter(({ version }) => version !== box.version);
if (values.box) {
  const next = await release(repo, values.box);
  console.log(`box: default ${box.repo} ${box.version} → ${next.repo} ${next.version}`);
  if (values["keep-previous"]) supported = [box, ...supported];
  box = next;
} else if (values.add) {
  if (values.add === box.version) throw new Error(`${values.add} is the default already`);
  console.log(`box: supporting ${repo} ${values.add} beside the default ${box.version}`);
  supported = [
    ...supported.filter(({ version }) => version !== values.add),
    await release(repo, values.add),
  ];
} else if (values.remove) {
  if (values.remove === box.version)
    throw new Error(`${values.remove} is the default: move --box first`);
  console.log(`box: no longer supporting ${values.remove}`);
  supported = supported.filter(({ version }) => version !== values.remove);
}
supported = supported.filter(({ version }) => version !== box.version);

await Bun.write(FILE, `${JSON.stringify({ box, supported }, null, 2)}\n`);
