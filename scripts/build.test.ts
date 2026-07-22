import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { AssetManager } from "../src/assetManager";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ASSETS_DIR = join(REPO_ROOT, "src", "assets");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "build-integ-"));
  dirs.push(d);
  return d;
}

async function tree(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[relative(root, abs)] = await readFile(abs, "utf8");
  }
  return out;
}

test("compiled binary renders cdk identically to the source tree", async () => {
  const work = await tempDir();
  const binary = join(work, "probe");

  // Minimal entrypoint: render embedded cdk to argv[1]. Kept in the temp dir so
  // it resolves AssetManager by absolute path without polluting the repo.
  const entrypoint = join(work, "probe.ts");
  await Bun.write(
    entrypoint,
    `import { AssetManager } from ${JSON.stringify(join(REPO_ROOT, "src/assetManager"))};\n` +
      `await new AssetManager(Bun.embeddedFiles).render("cdk", process.argv[2]);\n`,
  );

  const assets = [...new Bun.Glob("**/*").scanSync({ cwd: ASSETS_DIR, onlyFiles: true, dot: true })]
    .sort()
    .map((r) => join(ASSETS_DIR, r));

  // process.platform reports "win32"; Bun's target is "windows".
  const os = process.platform === "win32" ? "windows" : process.platform;
  const hostTarget = `bun-${os}-${process.arch}` as Bun.Build.CompileTarget;

  const built = await Bun.build({
    entrypoints: [entrypoint, ...assets],
    compile: { target: hostTarget, outfile: binary },
    root: REPO_ROOT,
    naming: { asset: "agentcore-assets/[dir]/[name].[ext]" },
    plugins: [
      {
        name: "asset-file-loader",
        setup(build) {
          build.onLoad({ filter: /src[/\\]assets[/\\]/ }, async ({ path }) => ({
            contents: await Bun.file(path).bytes(),
            loader: "file",
          }));
        },
      },
    ],
  });
  expect(built.success).toBe(true);

  const embeddedOut = join(work, "embedded");
  const proc = Bun.spawnSync([binary, embeddedOut]);
  expect(proc.exitCode).toBe(0);

  const sourceOut = join(work, "source");
  await new AssetManager([], ASSETS_DIR).render("cdk", sourceOut);

  expect(await tree(embeddedOut)).toEqual(await tree(sourceOut));
});
