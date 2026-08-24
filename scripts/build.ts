#!/usr/bin/env bun

import { $ } from "bun";
import { join, resolve } from "node:path";
import { runWithExitCode } from "../src/runnable";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ASSETS_DIR = join(REPO_ROOT, "src", "assets");
const ENTRYPOINT = join(REPO_ROOT, "src", "index.ts");
const DIST = join(REPO_ROOT, "dist");

const ASSET_NAMING = "agentcore-assets/[dir]/[name].[ext]";

// The Toolkit reads files relative to its own package directory at runtime
// (bundledPackageRootDir(__dirname)), so the npm bundle keeps that package
// intact rather than inlining it.
//
// This covers the npm bundle only. compile() below cannot use the same trick:
// a standalone binary ships no node_modules, so marking the Toolkit external
// would leave an unresolvable require. Bun instead inlines it and rewrites
// __dirname to the *build machine's* path, which resolves on the builder and
// fails everywhere else. Binaries therefore have to hand the Toolkit an
// explicit copy of anything it would otherwise read from its package.
const EXTERNAL = ["@aws-cdk/toolkit-lib"];

// Shrink whitespace/syntax but keep identifiers: minified names make stack
// traces unreadable and erase error names telemetry keys on.
const MINIFY = { whitespace: true, syntax: true, identifiers: false } as const;

/** Absolute paths of every asset file. dot:true so hidden files (.prettierrc) are included. */
function discoverAssets(): string[] {
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: ASSETS_DIR, onlyFiles: true, dot: true })];
  return files.sort().map((relativePath) => join(ASSETS_DIR, relativePath));
}

/** Force asset files through the file loader so template .ts/.js are embedded as bytes, not compiled. */
function assetLoaderPlugin(): Bun.BunPlugin {
  return {
    name: "asset-file-loader",
    setup(build) {
      build.onLoad({ filter: /src[/\\]assets[/\\]/ }, async ({ path }) => ({
        contents: await Bun.file(path).bytes(),
        loader: "file",
      }));
    },
  };
}

/** Fail loudly on a non-UTF-8 asset — the source reads every asset as text. */
async function assertAssetsAreText(assets: string[]): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const path of assets) {
    try {
      decoder.decode(await Bun.file(path).bytes());
    } catch {
      throw new Error(`Asset is not valid UTF-8: ${path}`);
    }
  }
}

// Bun.build rejects with an AggregateError on failure (throw defaults to true),
// so build errors propagate to runWithExitCode like any other.
async function bundle(): Promise<void> {
  await Bun.build({
    entrypoints: [ENTRYPOINT],
    outdir: DIST,
    target: "node",
    minify: MINIFY,
    external: EXTERNAL,
  });

  // Mirror assets beside the emitted module for resolveAssetsRoot().
  const distAssets = join(DIST, "assets");
  await $`rm -rf ${distAssets}`;
  await $`cp -R ${ASSETS_DIR} ${distAssets}`;
  console.log(`Bundled to ${join(DIST, "index.js")} with assets/`);
}

async function compile(target: string): Promise<void> {
  const assets = discoverAssets();
  await assertAssetsAreText(assets);

  const outfile = join(DIST, "bin", `agentcore-${target.replace(/^bun-/, "")}`);
  await $`mkdir -p ${join(DIST, "bin")}`;

  await Bun.build({
    entrypoints: [ENTRYPOINT, ...assets],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    minify: MINIFY,
    root: REPO_ROOT,
    naming: { asset: ASSET_NAMING },
    plugins: [assetLoaderPlugin()],
  });
  console.log(`Compiled ${target} → ${outfile} (${assets.length} assets embedded)`);
}

process.exit(
  await runWithExitCode(async () => {
    const [command, target] = process.argv.slice(2);

    if (command === "bundle") {
      await bundle();
    } else if (command === "compile") {
      if (!target) {
        throw new Error("Usage: bun scripts/build.ts compile <bun-target>");
      }
      await compile(target);
    } else {
      throw new Error("Usage: bun scripts/build.ts <bundle|compile <target>>");
    }
  }),
);
