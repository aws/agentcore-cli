import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Mount metadata and process-group cleanup are Linux contracts of the Runtime bootstrap.
test.skipIf(process.platform !== "linux")(
  "deferred Box bootstrap preserves HTTP behavior and manages one child after mounts are ready",
  () => {
    const result = spawnSync(
      "python3",
      [join(import.meta.dir, "box_runtime_bootstrap_test.py"), "-v"],
      { encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Runtime bootstrap behavior suite failed:\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
  },
  35_000,
);
