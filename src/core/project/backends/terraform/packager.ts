import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { atomicWrite, type ProcessRunner } from "../../../../io";
import { InputValidationError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";

export type RuntimeArtifact = { path: string; sha256: string };
const MAX_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_ZIP = 50 * 1024 * 1024;
const EXCLUDED = new Set([".git", ".venv", "__pycache__", "node_modules", ".terraform", "uv.lock"]);

/** Produces immutable ARM64 Python artifacts using the declared runtime version. */
export class PythonArtifactBuilder {
  constructor(private readonly runner: ProcessRunner) {}

  async build(
    project: Project,
    onOutput: (chunk: string) => void,
  ): Promise<Record<string, RuntimeArtifact>> {
    const artifacts: Record<string, RuntimeArtifact> = {};
    const root = join(project.rootPath, "agentcore", ".cli", "terraform", "artifacts");
    await mkdir(root, { recursive: true });
    for (const runtime of project.spec.runtimes) {
      const source = await realpath(resolve(project.rootPath, runtime.codeLocation));
      const relativeSource = relative(await realpath(project.rootPath), source);
      if (!relativeSource || relativeSource.startsWith("..") || isAbsolute(relativeSource)) {
        throw new InputValidationError(
          "Runtime codeLocation must be a directory inside the project.",
        );
      }
      const stage = await mkdtemp(join(root, `${runtime.name}-`));
      const manifest = join(source, "pyproject.toml");
      if (existsSync(manifest)) {
        if (!existsSync(join(source, "uv.lock"))) {
          throw new InputValidationError(
            `Run 'uv lock' in ${source} before building Terraform artifacts.`,
          );
        }
        const requirements = join(stage, "requirements.txt");
        await this.runner(
          [
            "uv",
            "export",
            "--frozen",
            "--no-dev",
            "--no-emit-project",
            "--no-hashes",
            "--output-file",
            requirements,
          ],
          {
            cwd: source,
            onOutput,
          },
        );
        const python = runtime.runtimeVersion!.slice("PYTHON_".length).replace("_", ".");
        await this.runner(
          [
            "uv",
            "pip",
            "install",
            "-r",
            requirements,
            "--target",
            join(stage, "dependencies"),
            "--python-version",
            python,
            "--python-platform",
            "aarch64-manylinux_2_28",
            "--only-binary",
            ":all:",
            "--link-mode",
            "copy",
          ],
          {
            cwd: source,
            onOutput,
          },
        );
      }
      const files: Zippable = {};
      let size = 0;
      const collect = async (directory: string, prefix = "") => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (
            EXCLUDED.has(entry.name) ||
            entry.name.startsWith(".env") ||
            entry.name.endsWith(".pyc")
          )
            continue;
          if (entry.isSymbolicLink())
            throw new InputValidationError(
              `Symlink '${join(directory, entry.name)}' is not supported in a runtime ZIP.`,
            );
          const path = join(directory, entry.name);
          const name = `${prefix}${entry.name}`;
          if (entry.isDirectory()) await collect(path, `${name}/`);
          else if (entry.isFile()) {
            const bytes = await readFile(path);
            size += bytes.length;
            if (size > MAX_UNCOMPRESSED)
              throw new InputValidationError("Runtime files exceed the 250 MiB unpacked limit.");
            files[name] = [bytes, { mtime: new Date(1980, 0, 1) }];
          }
        }
      };
      if (existsSync(join(stage, "dependencies"))) await collect(join(stage, "dependencies"));
      await collect(source);
      if (!files[runtime.entrypoint])
        throw new InputValidationError(
          `Entrypoint '${runtime.entrypoint}' is missing from the runtime ZIP.`,
        );
      const zip = zipSync(files, { level: 6 });
      if (zip.length > MAX_ZIP) throw new InputValidationError("Runtime ZIP exceeds 50 MiB.");
      const sha256 = createHash("sha256").update(zip).digest("hex");
      const path = join(root, `${runtime.name}-${sha256}.zip`);
      await atomicWrite(path, zip, { mode: 0o600 });
      artifacts[runtime.name] = { path, sha256 };
    }
    return artifacts;
  }
}
