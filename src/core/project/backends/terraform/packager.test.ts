import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { PythonArtifactBuilder } from "./packager";
import type { Project } from "../../../../handlers/project/types";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "terraform-package-test-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "app", "agent"), { recursive: true });
  await writeFile(join(rootPath, "app", "agent", "main.py"), "print('hello')\n");
  return {
    name: "Demo",
    rootPath,
    spec: ProjectSpecSchema.parse({
      name: "Demo",
      version: 1,
      managedBy: "TERRAFORM",
      runtimes: [
        {
          name: "agent",
          build: "CodeZip",
          runtimeVersion: "PYTHON_3_12",
          codeLocation: "app/agent",
          entrypoint: "main.py",
        },
      ],
    }),
  };
}
const builder = () =>
  new PythonArtifactBuilder(async () => {
    throw new Error("unexpected command");
  });

test("source timestamps do not change the artifact, and local environment files stay out", async () => {
  const project = await fixture();
  await writeFile(join(project.rootPath, "app", "agent", ".env.local"), "local-secret");
  const first = (await builder().build(project, () => {})).agent!;
  await utimes(join(project.rootPath, "app", "agent", "main.py"), new Date(), new Date());
  const second = (await builder().build(project, () => {})).agent!;
  expect(first.sha256).toBe(second.sha256);
  expect(Object.keys(unzipSync(await readFile(first.path)))).toEqual(["main.py"]);
});

test("rejects source symlinks instead of including files outside the source tree", async () => {
  const project = await fixture();
  await symlink(
    join(project.rootPath, "app", "agent", "main.py"),
    join(project.rootPath, "app", "agent", "linked.py"),
  );
  await expect(builder().build(project, () => {})).rejects.toThrow("Symlink");
});

test("requires a dependency lock rather than resolving different packages during deploy", async () => {
  const project = await fixture();
  await writeFile(join(project.rootPath, "app", "agent", "pyproject.toml"), "[project]\n");
  await expect(builder().build(project, () => {})).rejects.toThrow("uv lock");
});
