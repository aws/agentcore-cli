import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { TerraformAssetPackager } from "./assets";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "terraform-assets-"));
  directories.push(rootPath);
  await mkdir(join(rootPath, "app"));
  await writeFile(join(rootPath, "app", "main.py"), "print('hello')\n");
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({
      name: "example",
      version: 2,
      managedBy: "Terraform",
      runtimes: [
        {
          name: "agent",
          build: "CodeZip",
          codeLocation: "app",
          entrypoint: "main.py",
          runtimeVersion: "PYTHON_3_12",
          instrumentation: { enableOtel: false },
        },
      ],
    }),
  };
}

test("ZIP hash ignores file timestamps and excludes secret files and local environments", async () => {
  const p = await fixture();
  await mkdir(join(p.rootPath, "app", ".venv"));
  await writeFile(join(p.rootPath, "app", ".venv", "secret.py"), "private");
  await writeFile(join(p.rootPath, "app", ".env.local"), "TOKEN=private");
  const packager = new TerraformAssetPackager(async () => {
    throw new Error("unexpected process");
  });
  const directory = join(p.rootPath, "agentcore", "terraform", "build");
  const first = await packager.build(p, directory, () => {});
  await utimes(join(p.rootPath, "app", "main.py"), new Date(), new Date());
  const second = await packager.build(p, directory, () => {});
  expect(first.runtimes.agent!.hash).toBe(second.runtimes.agent!.hash);
  const contents = unzipSync(await readFile(first.runtimes.agent!.path));
  expect(Object.keys(contents)).toEqual(["main.py"]);
  await writeFile(join(p.rootPath, "app", "main.py"), "print('changed')\n");
  const third = await packager.build(p, directory, () => {});
  expect(third.runtimes.agent!.hash).not.toBe(first.runtimes.agent!.hash);
});

test("source symlinks fail before their contents are packaged", async () => {
  if (process.platform === "win32") return;
  const p = await fixture();
  await symlink(join(p.rootPath, "app", "main.py"), join(p.rootPath, "app", "linked.py"));
  const packager = new TerraformAssetPackager(async () => {});
  await expect(
    packager.build(p, join(p.rootPath, "agentcore", "terraform", "build"), () => {}),
  ).rejects.toThrow("symbolic links");
});

test("instrumentation requires an explicit dependency", async () => {
  const p = await fixture();
  p.spec.runtimes[0]!.instrumentation = { enableOtel: true };
  const packager = new TerraformAssetPackager(async () => {});
  await expect(
    packager.build(p, join(p.rootPath, "agentcore", "terraform", "build"), () => {}),
  ).rejects.toThrow("does not declare aws-opentelemetry-distro");
});

test("a missing runtime entrypoint fails before installing dependencies", async () => {
  const p = await fixture();
  p.spec.runtimes[0]!.entrypoint = "missing.py";
  let ran = false;
  const packager = new TerraformAssetPackager(async () => {
    ran = true;
  });
  await expect(
    packager.build(p, join(p.rootPath, "agentcore", "terraform", "build"), () => {}),
  ).rejects.toThrow("entrypoint does not exist");
  expect(ran).toBe(false);
});

test("rejects assets above the uncompressed Lambda ZIP limit", async () => {
  const p = await fixture();
  const largeFile = join(p.rootPath, "app", "large.dat");
  await writeFile(largeFile, "");
  await truncate(largeFile, 250 * 1024 * 1024 + 1);
  const packager = new TerraformAssetPackager(async () => {});
  await expect(
    packager.build(p, join(p.rootPath, "agentcore", "terraform", "build"), () => {}),
  ).rejects.toThrow("250 MiB when uncompressed");
});
