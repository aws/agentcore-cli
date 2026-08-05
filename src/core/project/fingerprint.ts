import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { PACKAGE_VERSION } from "../../constants";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function excluded(relativePath: string, isDirectory: boolean): boolean {
  const normalized = normalize(relativePath);
  const segments = normalized.split("/");

  if (isDirectory && segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return true;
  }

  return (
    normalized === "agentcore/.build" ||
    normalized.startsWith("agentcore/.build/") ||
    normalized === "agentcore/.cache" ||
    normalized.startsWith("agentcore/.cache/") ||
    normalized === "agentcore/.cli" ||
    normalized.startsWith("agentcore/.cli/") ||
    normalized === "agentcore/cdk/cdk.out" ||
    normalized.startsWith("agentcore/cdk/cdk.out/") ||
    normalized === "agentcore/cdk/.cdk.staging" ||
    normalized.startsWith("agentcore/cdk/.cdk.staging/") ||
    normalized === "agentcore/cdk/dist" ||
    normalized.startsWith("agentcore/cdk/dist/") ||
    segments.some((segment) => segment === ".env" || segment.startsWith(".env."))
  );
}

async function projectFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(directory, entry.name);
    const relativePath = relative(root, absolutePath);
    if (excluded(relativePath, entry.isDirectory())) continue;

    if (entry.isDirectory()) {
      paths.push(...(await projectFiles(root, absolutePath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(absolutePath);
    }
  }

  return paths;
}

/** Hashes build inputs by path and content, excluding generated output and dependency directories. */
export async function computeProjectFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`agentcore-cli:${PACKAGE_VERSION}\0`);

  for (const absolutePath of await projectFiles(root)) {
    const relativePath = normalize(relative(root, absolutePath));
    const stats = await lstat(absolutePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(stats.mode & 0o777));
    hash.update("\0");

    if (stats.isSymbolicLink()) {
      hash.update("link\0");
      hash.update(await readlink(absolutePath));
    } else {
      hash.update("file\0");
      hash.update(await readFile(absolutePath));
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}
