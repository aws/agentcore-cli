import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKUP_RELATIVE_PATH, writeMigratedFiles } from "./files";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function tree(files: Record<string, string>, directories: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-files-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const directory of directories) await mkdir(join(root, directory), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** Writes a stand-in for v1's vended CDK app. */
const vendedApp = async (cdkDirectory: string) => {
  await mkdir(join(cdkDirectory, "bin"), { recursive: true });
  await writeFile(join(cdkDirectory, "bin", "cdk.ts"), "v1 app");
};

describe("writeMigratedFiles", () => {
  test("writes, then restores exactly, keeping directories that were there", async () => {
    const project = await tree(
      {
        "agentcore/agentcore.json": "v0",
        "agentcore/cdk/bin/cdk.ts": "v0 app",
        "agentcore/cdk/node_modules/x.js": "dep",
        "app/h/harness.json": "{}",
      },
      ["app/empty"],
    );
    const workspace = await tree({
      "agentcore/agentcore.json": "v1",
      "agentcore/cdk/bin/cdk.ts": "v1 app",
      "agentcore/cdk/node_modules/y.js": "not copied",
      "app/empty/new.txt": "new",
      "app/fresh/deep/new.txt": "new",
    });

    const backup = await writeMigratedFiles({
      rootPath: project,
      workspaceDirectory: workspace,
      writeCdkApp: vendedApp,
      changes: [
        { path: "agentcore/agentcore.json", kind: "modified" },
        { path: "agentcore/cdk/bin/cdk.ts", kind: "modified" },
        { path: "app/empty/new.txt", kind: "added" },
        { path: "app/fresh/deep/new.txt", kind: "added" },
        { path: "app/h/harness.json", kind: "removed" },
      ],
    });

    const read = (path: string) => readFileSync(join(project, path), "utf8");
    expect(read("agentcore/agentcore.json")).toBe("v1");
    expect(read("agentcore/cdk/bin/cdk.ts")).toBe("v1 app");
    expect(existsSync(join(project, "agentcore/cdk/node_modules"))).toBe(false);
    expect(existsSync(join(project, "app/h"))).toBe(false);
    expect(read("app/fresh/deep/new.txt")).toBe("new");

    await backup.restore();

    expect(read("agentcore/agentcore.json")).toBe("v0");
    expect(read("agentcore/cdk/bin/cdk.ts")).toBe("v0 app");
    expect(read("agentcore/cdk/node_modules/x.js")).toBe("dep");
    expect(read("app/h/harness.json")).toBe("{}");
    expect(existsSync(join(project, "app/empty"))).toBe(true);
    expect(existsSync(join(project, "app/empty/new.txt"))).toBe(false);
    expect(existsSync(join(project, "app/fresh"))).toBe(false);
    expect(existsSync(join(project, BACKUP_RELATIVE_PATH))).toBe(false);
  });

  test("restores every other file when one can't be put back, keeping the backup", async () => {
    const project = await tree({
      "agentcore/agentcore.json": "v0",
      "agentcore/cdk/bin/cdk.ts": "v0 app",
      "app/a.txt": "a0",
    });
    const workspace = await tree({
      "agentcore/agentcore.json": "v1",
      "agentcore/cdk/bin/cdk.ts": "v1 app",
      "app/a.txt": "a1",
    });
    const backup = await writeMigratedFiles({
      rootPath: project,
      workspaceDirectory: workspace,
      writeCdkApp: vendedApp,
      changes: [
        { path: "agentcore/agentcore.json", kind: "modified" },
        { path: "app/a.txt", kind: "modified" },
      ],
    });
    // Lose one backed-up original.
    await rm(join(project, BACKUP_RELATIVE_PATH, "files", "app", "a.txt"));

    await expect(backup.restore()).rejects.toThrow("1 path couldn't be put back (app/a.txt:");

    expect(readFileSync(join(project, "agentcore/agentcore.json"), "utf8")).toBe("v0");
    expect(readFileSync(join(project, "agentcore/cdk/bin/cdk.ts"), "utf8")).toBe("v0 app");
    expect(existsSync(join(project, BACKUP_RELATIVE_PATH))).toBe(true);
  });
});
