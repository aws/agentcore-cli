#!/usr/bin/env bun

import { $ } from "bun";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
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

const BOOTSTRAP_TEMPLATE = ["lib", "api", "bootstrap", "bootstrap-template.yaml"];

// Shrink whitespace/syntax but keep identifiers: minified names make stack
// traces unreadable and erase error names telemetry keys on.
const MINIFY = { whitespace: true, syntax: true, identifiers: false } as const;

const DEFINE = { "process.env.NODE_ENV": JSON.stringify("production") };

/** Absolute paths of every asset file. dot:true so hidden files (.prettierrc) are included. */
function discoverAssets(): string[] {
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: ASSETS_DIR, onlyFiles: true, dot: true })];
  return files.sort().map((relativePath) => join(ASSETS_DIR, relativePath));
}

/**
 * Stage the prebuilt Agent Inspector SPA into the asset tree (gitignored) so
 * both distribution paths ship it through the ordinary asset machinery:
 * `bundle` mirrors it into dist/assets/, `compile` embeds it in the binary.
 * Every file gains a neutral `.asset` suffix — compile passes assets as
 * Bun.build entrypoints, and a bare .html entrypoint would be bundled through
 * Bun's HTML-imports pipeline instead of embedded verbatim. InspectorAssets
 * strips the suffix when reading.
 */
async function stageInspectorAssets(): Promise<void> {
  const source = join(REPO_ROOT, "node_modules", "@aws", "agent-inspector", "dist-assets");
  if (!(await Bun.file(join(source, "index.html")).exists())) {
    throw new Error("@aws/agent-inspector is not installed — run `bun install` before building.");
  }
  const target = join(ASSETS_DIR, "agent-inspector");
  await $`rm -rf ${target}`;
  await $`mkdir -p ${target}`;
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: source, onlyFiles: true })];
  for (const file of files) {
    await $`cp ${join(source, file)} ${join(target, `${file}.asset`)}`;
  }
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

function runtimeShellSdkPlugin(): Bun.BunPlugin {
  const runtimeEntry = Bun.resolveSync("bedrock-agentcore/runtime", REPO_ROOT);
  const runtimeClient = join(resolve(runtimeEntry, ".."), "client.js");

  return {
    name: "runtime-shell-sdk-client",
    setup(build) {
      build.onResolve({ filter: /^bedrock-agentcore\/runtime$/ }, () => ({
        path: runtimeClient,
      }));
    },
  };
}

function bootstrapTemplate(): string {
  const manifest = Bun.resolveSync("@aws-cdk/toolkit-lib/package.json", REPO_ROOT);
  const template = join(resolve(manifest, ".."), ...BOOTSTRAP_TEMPLATE);
  if (!existsSync(template)) {
    throw new Error(
      `@aws-cdk/toolkit-lib no longer ships ${BOOTSTRAP_TEMPLATE.join("/")}; ` +
        `looked in ${template}`,
    );
  }
  return template;
}

async function assertTemplateIsEmbedded(outfile: string, template: string): Promise<void> {
  const [executable, contents] = await Promise.all([
    Bun.file(outfile).bytes(),
    Bun.file(template).bytes(),
  ]);
  if (!Buffer.from(executable).includes(contents)) {
    throw new Error(`${outfile} does not contain ${BOOTSTRAP_TEMPLATE.join("/")}`);
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

/**
 V8 only caches modules loaded after enableCompileCache(), so the bin is a loader in front of the bundle.
**/
const BIN_LOADER = `#!/usr/bin/env node
import module from "node:module";
module.enableCompileCache?.();
await import("./main.js");
`;

// Bun.build rejects with an AggregateError on failure (throw defaults to true),
// so build errors propagate to runWithExitCode like any other.
async function bundle(): Promise<void> {
  await stageInspectorAssets();
  await Bun.build({
    entrypoints: [ENTRYPOINT],
    outdir: DIST,
    naming: { entry: "main.js" },
    target: "node",
    minify: MINIFY,
    define: DEFINE,
    external: EXTERNAL,
    plugins: [runtimeShellSdkPlugin()],
  });
  const bin = join(DIST, "index.js");
  await Bun.write(bin, BIN_LOADER);
  await chmod(bin, 0o755);

  // Mirror assets beside the emitted module for resolveAssetsRoot().
  const distAssets = join(DIST, "assets");
  await $`rm -rf ${distAssets}`;
  await $`cp -R ${ASSETS_DIR} ${distAssets}`;
  console.log(`Bundled to ${join(DIST, "main.js")} behind ${join(DIST, "index.js")} with assets/`);
}

async function compile(target: string): Promise<void> {
  await stageInspectorAssets();
  const assets = discoverAssets();
  await assertAssetsAreText(assets);

  // Bun appends .exe to a Windows executable whose outfile has no extension, so
  // the emitted path is not the one we asked for. Name it in full instead: the
  // embed assertion below and the CI smoke test both read this exact path.
  const extension = target.includes("windows") ? ".exe" : "";
  const outfile = join(DIST, "bin", `agentcore-${target.replace(/^bun-/, "")}${extension}`);
  await $`mkdir -p ${join(DIST, "bin")}`;

  const template = bootstrapTemplate();
  await Bun.build({
    entrypoints: [ENTRYPOINT, ...assets, template],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    minify: MINIFY,
    define: DEFINE,
    root: REPO_ROOT,
    naming: { asset: ASSET_NAMING },
    plugins: [assetLoaderPlugin(), runtimeShellSdkPlugin()],
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
