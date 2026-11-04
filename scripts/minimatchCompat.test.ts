import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test.each([
  [
    "CommonJS",
    [
      "-e",
      'const minimatch = require("minimatch"); if (!minimatch("file.ts", "*.ts") || typeof minimatch.Minimatch !== "function") process.exit(1);',
    ],
  ],
  [
    "ESM",
    [
      "--input-type=module",
      "-e",
      'import minimatch from "minimatch"; if (!minimatch("file.ts", "*.ts") || typeof minimatch.Minimatch !== "function") process.exit(1);',
    ],
  ],
] as const)("patched minimatch supports %s consumers", (_format, args) => {
  const child = spawnSync("node", args, { cwd: import.meta.dir + "/..", encoding: "utf8" });
  expect({ error: child.error, status: child.status, stderr: child.stderr }).toEqual({
    error: undefined,
    status: 0,
    stderr: "",
  });
});
