#!/usr/bin/env bun

import { $ } from "bun";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";

// Run after `bun run build`. Keep registry-backed packaging checks out of the offline unit suite.
const repo = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "agentcore-package-install-"));
const env = { ...process.env, AGENTCORE_TELEMETRY_DISABLED: "1" };

try {
  const tarball = join(root, "agentcore.tgz");
  await $`${process.execPath} pm pack --ignore-scripts --filename ${tarball} --quiet`.cwd(repo);

  for (const typescript of ["5.9.3", "6.0.3", "7.0.2", undefined]) {
    const label = typescript ? `TypeScript ${typescript}` : "no host TypeScript";
    const host = join(root, typescript ?? "no-typescript");
    await mkdir(host);
    try {
      await writeFile(
        join(host, "package.json"),
        JSON.stringify({
          name: "agentcore-install-smoke",
          version: "1.0.0",
          private: true,
          devDependencies: typescript ? { typescript } : {},
        }),
      );
      // Explicitly reject local npm settings that would conceal the original ERESOLVE failure.
      await $`npm install --save-dev ${tarball} --ignore-scripts --no-audit --no-fund --legacy-peer-deps=false --force=false`
        .cwd(host)
        .env(env);
      await $`npm ls --depth=0`.cwd(host).env(env);
      if (typescript) {
        const installed = JSON.parse(
          await readFile(join(host, "node_modules/typescript/package.json"), "utf8"),
        ) as { version: string };
        assert.equal(installed.version, typescript);
      }
      const cli = join(host, "node_modules/@aws/agentcore/dist/index.js");
      const version = await $`node ${cli} --version`.cwd(host).env(env).text();
      assert.equal(version.trim(), manifest.version);
      const help = await $`node ${cli} --help`.cwd(host).env(env).text();
      assert.match(help, /Usage: agentcore/);
      console.log(`PASS: install, --version and --help with ${label}`);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
