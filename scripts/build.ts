#!/usr/bin/env bun

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runWithExitCode } from "../src/runnable";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ASSETS_DIR = join(REPO_ROOT, "src", "assets");
const ENTRYPOINT = join(REPO_ROOT, "src", "index.ts");
const DIST = join(REPO_ROOT, "dist");

const ASSET_NAMING = "agentcore-assets/[dir]/[name].[ext]";

// Kept out of the bundle so the toolkit stays a real directory in node_modules at
// runtime: it reads its bootstrap template from its own package directory, which a
// bundle would rewrite to this machine's absolute path. The npm package declares it
// as a dependency, so installing the CLI installs it.
const EXTERNAL = ["@aws-cdk/toolkit-lib"];

// A compiled executable has no node_modules, so the template the toolkit would read
// from its package directory is embedded instead. See loadBootstrapTemplate.
const BOOTSTRAP_TEMPLATE = ["lib", "api", "bootstrap", "bootstrap-template.yaml"];

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
      build.onLoad(
        { filter: /src[/\\]assets[/\\]|bootstrap-template\.yaml$/ },
        async ({ path }) => ({
          contents: await Bun.file(path).bytes(),
          loader: "file",
        }),
      );
    },
  };
}

/**
 * Absolute path of the toolkit's own bootstrap template.
 *
 * Resolved from the installed package rather than a copy in this repo, so the
 * embedded template is always the one the toolkit being compiled in expects.
 */
function bootstrapTemplate(): string {
  const manifest = Bun.resolveSync("@aws-cdk/toolkit-lib/package.json", REPO_ROOT);
  const template = join(resolve(manifest, ".."), ...BOOTSTRAP_TEMPLATE);
  if (!existsSync(template)) {
    throw new Error(
      `@aws-cdk/toolkit-lib no longer ships ${BOOTSTRAP_TEMPLATE.join("/")}; ` +
        `bootstrap in a compiled executable reads the embedded copy, so this must be found. Looked in ${template}`,
    );
  }
  return template;
}

/**
 * Fail loudly unless the compiled executable carries the bootstrap template's bytes.
 *
 * Nothing reads that template until someone bootstraps an AWS account, so an
 * executable that lost it looks healthy in every build check and fails in a user's
 * first deploy instead.
 */
async function assertTemplateIsEmbedded(outfile: string, template: string): Promise<void> {
  const [executable, bytes] = await Promise.all([
    Bun.file(outfile).bytes(),
    Bun.file(template).bytes(),
  ]);
  if (!Buffer.from(executable).includes(bytes)) {
    throw new Error(
      `${outfile} does not carry ${BOOTSTRAP_TEMPLATE.join("/")}, so bootstrap would fail wherever it runs`,
    );
  }
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

  // Bun appends .exe to a Windows executable whatever it is asked for, so the extension
  // is asked for: the name below is also the one this script then reads back and the one
  // the build workflow smoke tests.
  const platform = target.replace(/^bun-/, "");
  const outfile = join(
    DIST,
    "bin",
    `agentcore-${platform}${platform.startsWith("windows") ? ".exe" : ""}`,
  );
  await $`mkdir -p ${join(DIST, "bin")}`;

  const template = bootstrapTemplate();
  await Bun.build({
    entrypoints: [ENTRYPOINT, ...assets, template],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    minify: MINIFY,
    root: REPO_ROOT,
    naming: { asset: ASSET_NAMING },
    plugins: [assetLoaderPlugin()],
  });
  await assertTemplateIsEmbedded(outfile, template);
  console.log(
    `Compiled ${target} → ${outfile} (${assets.length} assets embedded, plus the bootstrap template)`,
  );
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
