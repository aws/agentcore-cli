import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import { atomicWrite, requireTool, type ProcessRunner } from "../../../../io";
import { resolvePathWithinProject } from "../../../dev/path";
import type { TerraformAssets } from "./types";

const EXCLUDED = new Set([
  ".git",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".DS_Store",
  "node_modules",
  "terraform",
]);
const MAX_ASSET_BYTES = 250 * 1024 * 1024;

type PackageInput = {
  name: string;
  source: string;
  entrypoint: string;
  pythonVersion: string;
  instrumentation: boolean;
};

export type TerraformAssetBuilder = (
  project: Project,
  directory: string,
  onOutput: (line: string) => void,
) => Promise<TerraformAssets>;

/** Builds deterministic Python ZIPs without copying local environments or secret files. */
export class TerraformAssetPackager {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly checkTool: typeof requireTool = requireTool,
  ) {}

  async build(
    project: Project,
    directory: string,
    onOutput: (line: string) => void,
  ): Promise<TerraformAssets> {
    await mkdir(join(directory, "assets"), { recursive: true, mode: 0o700 });
    const assets: TerraformAssets = { runtimes: {}, gatewayTargets: {} };
    for (const runtime of project.spec.runtimes) {
      assets.runtimes[runtime.name] = await this.package(
        project,
        directory,
        {
          name: `runtime-${runtime.name}`,
          source: runtime.codeLocation,
          entrypoint: runtime.entrypoint.split(":")[0]!,
          pythonVersion: runtime.runtimeVersion!,
          instrumentation: runtime.instrumentation?.enableOtel !== false,
        },
        onOutput,
      );
    }
    for (const gateway of project.spec.agentCoreGateways) {
      for (const target of gateway.targets) {
        if (target.targetType !== "lambda" || target.compute?.host !== "Lambda") continue;
        assets.gatewayTargets[`${gateway.name}/${target.name}`] = await this.package(
          project,
          directory,
          {
            name: `gateway-${gateway.name}-${target.name}`,
            source: target.compute.implementation.path,
            entrypoint: `${target.compute.implementation.handler.replace(/[:.][^:.]+$/, "").replaceAll(".", "/")}.py`,
            pythonVersion: target.compute.pythonVersion!,
            instrumentation: false,
          },
          onOutput,
        );
      }
    }
    return assets;
  }

  private async package(
    project: Project,
    directory: string,
    input: PackageInput,
    onOutput: (line: string) => void,
  ): Promise<{ path: string; hash: string }> {
    const source = resolvePathWithinProject(
      project.rootPath,
      resolve(project.rootPath, input.source),
      `${input.name} code directory`,
    );
    if (!(await stat(source)).isDirectory()) {
      throw new ProjectStateError(`${input.name} source must be a directory`);
    }
    // Reject a project-root code location: it would recursively package Terraform's own state.
    if ((await realpath(project.rootPath)) === source) {
      throw new ProjectStateError(
        `${input.name} codeLocation must be a subdirectory of the project`,
      );
    }
    const entrypoint = resolve(source, input.entrypoint);
    if (!existsSync(entrypoint) || !(await stat(entrypoint)).isFile()) {
      throw new ProjectStateError(`${input.name} entrypoint does not exist: ${input.entrypoint}`);
    }
    resolvePathWithinProject(source, entrypoint, `${input.name} entrypoint`);
    const staging = await mkdtemp(join(directory, "assets", ".staging-"));
    try {
      const pyproject = join(source, "pyproject.toml");
      const requirements = join(source, "requirements.txt");
      const hasPyproject = existsSync(pyproject);
      const manifest = hasPyproject
        ? pyproject
        : existsSync(requirements)
          ? requirements
          : undefined;
      if (input.instrumentation) {
        const text = manifest ? await readFile(manifest, "utf8") : "";
        if (!/aws[-_]opentelemetry[-_]distro/i.test(text)) {
          throw new ProjectStateError(
            `${input.name} enables instrumentation but does not declare aws-opentelemetry-distro. ` +
              "Add it to the Python dependencies, or set instrumentation.enableOtel to false.",
          );
        }
      }
      if (manifest) {
        await this.checkTool(
          "uv",
          "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
        );
        const version = input.pythonVersion.replace("PYTHON_", "").replaceAll("_", ".");
        let requirementPath = requirements;
        if (hasPyproject) {
          if (!existsSync(join(source, "uv.lock"))) {
            throw new ProjectStateError(
              `${input.name} has no uv.lock. Run 'uv lock' in ${source} before building.`,
            );
          }
          requirementPath = join(staging, ".requirements.txt");
          await this.runner(
            [
              "uv",
              "export",
              "--frozen",
              "--no-dev",
              "--no-emit-project",
              "--no-editable",
              "--output-file",
              requirementPath,
            ],
            { cwd: source, onOutput },
          );
        } else {
          const fingerprint = createHash("sha256")
            .update(version)
            .update(await readFile(requirements))
            .digest("hex");
          requirementPath = join(directory, "assets", `requirements-${fingerprint}.txt`);
          if (!existsSync(requirementPath)) {
            await this.runner(
              [
                "uv",
                "pip",
                "compile",
                "--python-version",
                version,
                "--python-platform",
                "aarch64-manylinux2014",
                "--generate-hashes",
                "--output-file",
                requirementPath,
                requirements,
              ],
              { cwd: source, onOutput },
            );
          }
        }
        await this.runner(
          [
            "uv",
            "pip",
            "install",
            "--python-version",
            version,
            "--python-platform",
            "aarch64-manylinux2014",
            "--only-binary",
            ":all:",
            "--no-compile-bytecode",
            "--require-hashes",
            "--target",
            staging,
            "--requirements",
            requirementPath,
          ],
          { cwd: source, onOutput },
        );
        await rm(join(staging, ".requirements.txt"), { force: true });
        // Dependencies' host console scripts embed local interpreter paths.
        // Runtime invokes only the portable OTEL script below; Lambda invokes its handler directly.
        await rm(join(staging, "bin"), { recursive: true, force: true });
        await rm(join(staging, "Scripts"), { recursive: true, force: true });
      }
      await this.copySource(source, staging);
      if (input.instrumentation) {
        // Host-generated console scripts carry an absolute host Python path.
        // Replace this entry point with a portable Linux script, including on Windows.
        await mkdir(join(staging, "bin"), { recursive: true });
        await writeFile(
          join(staging, "bin", "opentelemetry-instrument"),
          "#!/usr/bin/env python3\nfrom opentelemetry.instrumentation.auto_instrumentation import run\nrun()\n",
          { mode: 0o755 },
        );
        await rm(join(staging, "bin", "opentelemetry-instrument.exe"), { force: true });
      }
      const files: Zippable = {};
      await this.collectZipEntries(staging, staging, files, { bytes: 0 });
      const zip = zipSync(files, { level: 6 });
      if (zip.byteLength > MAX_ASSET_BYTES) {
        throw new ProjectStateError(`${input.name} ZIP exceeds 250 MiB`);
      }
      const hash = createHash("sha256").update(zip).digest("hex");
      const path = join(directory, "assets", `${hash}.zip`);
      await atomicWrite(path, zip, { mode: 0o600 });
      return { path, hash };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async copySource(source: string, destination: string): Promise<void> {
    await cp(source, destination, {
      recursive: true,
      filter: async (path) => {
        const name = basename(path);
        if (EXCLUDED.has(name) || name === ".env" || name.startsWith(".env.")) return false;
        const entry = await lstat(path);
        if (entry.isSymbolicLink()) {
          throw new ProjectStateError(
            `Python asset sources cannot contain symbolic links: ${path}`,
          );
        }
        return true;
      },
    });
  }

  private async collectZipEntries(
    root: string,
    directory: string,
    files: Zippable,
    total: { bytes: number },
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ProjectStateError(`Python dependencies cannot contain symbolic links: ${path}`);
      }
      if (entry.isDirectory()) {
        await this.collectZipEntries(root, path, files, total);
      } else if (entry.isFile()) {
        total.bytes += (await stat(path)).size;
        if (total.bytes > MAX_ASSET_BYTES) {
          throw new ProjectStateError("Python asset exceeds 250 MiB when uncompressed");
        }
        const name = relative(root, path).replaceAll("\\", "/");
        files[name] = [
          await readFile(path),
          {
            mtime: new Date("1980-01-01T00:00:00Z"),
            os: 3,
            attrs: (name.startsWith("bin/") ? 0o100755 : 0o100644) << 16,
          },
        ];
      }
    }
  }
}
