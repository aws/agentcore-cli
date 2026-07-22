#!/usr/bin/env bun

import { $ } from "bun";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ASSETS_DIR = join(REPO_ROOT, "src", "assets");
const ENTRYPOINT = join(REPO_ROOT, "src", "index.ts");
const DIST = join(REPO_ROOT, "dist");

const ASSET_NAMING = "agentcore-assets/[dir]/[name].[ext]";

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

/** Fail loudly on a non-UTF-8 asset — AssetManager renders everything as text. */
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

function reportAndExit(result: Bun.BuildOutput): void {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

async function bundle(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [ENTRYPOINT],
    outdir: DIST,
    target: "node",
    minify: true,
  });
  reportAndExit(result);

  // Mirror assets beside the emitted module for resolveSourceRoot().
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

  const result = await Bun.build({
    entrypoints: [ENTRYPOINT, ...assets],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    minify: true,
    root: REPO_ROOT,
    naming: { asset: ASSET_NAMING },
    plugins: [assetLoaderPlugin()],
  });
  reportAndExit(result);
  console.log(`Compiled ${target} → ${outfile} (${assets.length} assets embedded)`);
}

const [command, target] = process.argv.slice(2);

if (command === "bundle") {
  await bundle();
} else if (command === "compile") {
  if (!target) {
    console.error("Usage: bun scripts/build.ts compile <bun-target>");
    process.exit(1);
  }
  await compile(target);
} else {
  console.error("Usage: bun scripts/build.ts <bundle|compile <target>>");
  process.exit(1);
}
